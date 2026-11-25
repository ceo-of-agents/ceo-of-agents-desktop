// Pure helpers for permission rules: proposing, validating, anchoring and matching deny rules.
// No I/O except the rule readers at the end.
// The app never auto-allows with its own parser: Claude Code decides with its own parser and rules, and the
// permission prompt tool is only called for what Claude Code would ask. The app honours deny rules (matching
// more is the safe direction) and proposes narrow "Always allow" rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_USER_QUESTION } from '../../shared/questions';
import { asObject, hqLocalSettingsFile, hqSettingsFile, readJsonObject, updateHqLocalSettings } from './local-settings';
import { artifactAction, artifactRuleFor, SAFE_ARTIFACT_ACTIONS } from './artifact-actions';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools whose rule argument is a path. */
const PATH_TOOLS = new Set(['Read', 'Grep', 'Glob', ...EDIT_TOOLS]);
/** Tools that read: no "Always allow" proposal (a bare rule would allow every path). */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

export function editPath(input: Obj): string | null {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
}

/** The path relative to cwd when the file is inside it, else the path unchanged. */
export function relPath(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

// ---------- Bash command parsing (for deny rules only) ----------

export interface BashParse {
  parts: string[];
}

/** Splits a command line on && || ; | & and newlines outside quotes. */
export function parseBash(command: string): BashParse {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const n = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c + (n ?? '');
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '>' && n === '&') {
      cur += c + n;
      i++;
      continue;
    }
    if (c === '&' && n === '&') {
      push();
      i++;
      continue;
    }
    if (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<') {
      push();
      continue;
    }
    if (c === '|' && n === '|') {
      push();
      i++;
      continue;
    }
    if (c === '|' || c === ';' || c === '\n') {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return { parts };
}

/** Splits one command into words, removing quotes. */
function words(part: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < part.length) cur += part[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < part.length) {
      cur += part[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** For deny matching: drops leading VAR=value words and strips the path from the program (matches more). */
function normalizeWords(part: string): string[] {
  const w = words(part);
  while (w.length > 0 && ASSIGN.test(w[0])) w.shift();
  if (w.length > 0) w[0] = path.posix.basename(w[0]);
  return w;
}

const nextNonFlag = (w: string[], from: number): number => {
  for (let i = from; i < w.length; i++) if (!w[i].startsWith('-')) return i;
  return -1;
};

/** The program plus its subcommand for multi-level CLIs, for example "gh issue list". */
export function commandPrefix(w: string[]): string | null {
  if (w.length === 0) return null;
  const prog = w[0];
  if (prog === 'git') {
    let i = 1;
    while (i < w.length && (w[i] === '-C' || w[i] === '-c')) i += 2;
    while (i < w.length && w[i].startsWith('-')) i++;
    return i < w.length ? `git ${w[i]}` : 'git';
  }
  if (prog === 'gh') {
    const g = nextNonFlag(w, 1);
    if (g < 0) return 'gh';
    if (w[g] === 'api') return 'gh api';
    const s = nextNonFlag(w, g + 1);
    return s < 0 ? `gh ${w[g]}` : `gh ${w[g]} ${w[s]}`;
  }
  if (prog === 'npm') {
    const s = nextNonFlag(w, 1);
    if (s < 0) return 'npm';
    if (w[s] === 'run' || w[s] === 'run-script') {
      const sc = nextNonFlag(w, s + 1);
      return sc < 0 ? `npm ${w[s]}` : `npm ${w[s]} ${w[sc]}`;
    }
    return `npm ${w[s]}`;
  }
  if (prog === 'docker' || prog === 'brew') {
    const s = nextNonFlag(w, 1);
    return s < 0 ? prog : `${prog} ${w[s]}`;
  }
  return prog;
}

// ---------- proposing ----------

/** Programs that run other programs or can do anything: "Always allow" proposes the exact command, never a prefix. */
const DANGEROUS_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'python', 'python3', 'python2', 'node', 'deno', 'bun', 'ruby', 'perl', 'php',
  'env', 'sudo', 'su', 'doas', 'xargs', 'eval', 'exec', 'source', '.', 'find', 'sed', 'awk', 'gawk', 'rm', 'docker', 'kubectl',
  'ssh', 'scp', 'curl', 'wget', 'osascript', 'open', 'nohup', 'time', 'timeout', 'watch',
  // also run packages: same class as node and python
  'npx', 'bunx', 'pnpx',
]);
const isDangerousProgram = (p: string): boolean => DANGEROUS_PROGRAMS.has(p) || p.startsWith('python');
/** CLIs whose second word is a subcommand: a prefix rule needs it. */
const MULTI_LEVEL = new Set(['git', 'gh', 'npm', 'brew']);
/** Characters that make a line too clever to generalise: substitution, redirection, subshell, escapes, backticks. */
const UNSAFE_LINE = /[$`\\><()]/;
const MAX_LINE = 200;
const GLOB_CHARS = /[*?[\]{}]/;

/** Programs that build, install, write or reconfigure: only the exact command is ever proposed or accepted as a rule. */
const EXACT_ONLY_PROGRAMS = new Set([
  'pnpm', 'yarn', 'cargo', 'go', 'make', 'swift', 'security', 'launchctl', 'defaults', 'tee', 'dd', 'tar', 'cp', 'mv', 'chmod',
]);
/** git subcommands that change history, refs or the remote: exact command only. */
const EXACT_ONLY_GIT = new Set(['push', 'reset', 'clean', 'checkout', 'branch', 'remote']);
/** Readers whose path arguments must stay inside the hq for a prefix rule. */
const PATH_READERS = new Set(['cat', 'head', 'tail', 'rg', 'grep']);
const SENSITIVE_NAMES = new Set(['.mcp.json', 'claude.md', 'agents.md']);

/** True for prefixes that are really exact-only: `gh api`, `git -c ...`, `git config`, a git flag before the subcommand, and the sets above. */
function isExactOnlyWords(w: string[]): boolean {
  if (w[0] === 'gh' && w[1] === 'api') return true;
  if (w[0] === 'git' && (w[1] === 'config' || (w[1] ?? '').startsWith('-') || EXACT_ONLY_GIT.has(w[1] ?? ''))) return true;
  if (w[0] === 'npm' && (w[1] === 'exec' || w[1] === 'x')) return true;
  return EXACT_ONLY_PROGRAMS.has(w[0]);
}

/** True when a path argument is outside the hq: absolute outside it, `~`, or with a `..` segment. Without a cwd, absolute counts as outside. */
function outsideHq(arg: string, cwd?: string): boolean {
  if (arg.startsWith('~') || arg.split('/').includes('..')) return true;
  if (!path.isAbsolute(arg)) return false;
  if (!cwd) return true;
  const rel = path.relative(cwd, arg);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * True for a path no rule is proposed for: `.mcp.json`, `CLAUDE.md`, `AGENTS.md` anywhere, and any dotfile or dot folder
 * outside the hq (a path segment starting with `.`, other than `.` and `..`).
 */
function sensitivePath(p: string, cwd?: string): boolean {
  const segs = p.split(/[\\/]/).filter(Boolean);
  const base = (segs[segs.length - 1] ?? '').toLowerCase();
  if (SENSITIVE_NAMES.has(base)) return true;
  if (!outsideHq(p, cwd) && !p.startsWith('~')) return false;
  return segs.some((x) => x.startsWith('.') && x !== '.' && x !== '..');
}

/** Checks the path-like words (not flags) of every command part: `[sensitive, readerOutside]`. */
function scanBashArgs(parts: string[][], cwd?: string): { sensitive: boolean; readerOutside: boolean } {
  let sensitive = false;
  let readerOutside = false;
  for (const w of parts) {
    for (const a of w.slice(1)) {
      if (a.startsWith('-')) continue;
      if (sensitivePath(a, cwd)) sensitive = true;
      if (PATH_READERS.has(w[0]) && outsideHq(a, cwd)) readerOutside = true;
    }
  }
  return { sensitive, readerOutside };
}

/** The Bash rule "Always allow" would propose, or '' when none is safe. */
function bashRule(command: string, cwd: string): string {
  const c = command.trim();
  if (!c || /[\r\n]/.test(c) || c.length > MAX_LINE || UNSAFE_LINE.test(c) || ASSIGN.test(c)) return '';
  const parts = parseBash(c).parts.map(words).filter((w) => w.length > 0);
  const first = parts.find((w) => w[0] !== 'cd') ?? parts[0];
  if (!first) return '';
  const prog = first[0];
  if (ASSIGN.test(prog) || (prog.includes('/') && prog !== '.') || prog.startsWith('~')) return '';
  const exact = () => (c.includes('*') ? '' : `Bash(${c})`);
  const scan = scanBashArgs(parts, cwd);
  if (scan.sensitive) return '';
  if (isDangerousProgram(prog) || isExactOnlyWords(first) || scan.readerOutside) return exact();
  const prefix = commandPrefix(first);
  if (!prefix) return '';
  // The prefix must be the literal first words, or a rule would never match the command.
  const pw = prefix.split(' ');
  if (!pw.every((x, i) => first[i] === x)) return exact();
  if (MULTI_LEVEL.has(prog) && pw.length < 2) return exact();
  return `Bash(${prefix} *)`;
}

/** Folders that hold agent, git, hook, CI or editor configuration. */
const CONFIG_SEGMENTS = new Set(['.claude', '.git', '.husky', '.github', '.vscode']);
const lowerSegments = (p: string): string[] => p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());

/**
 * True when a path names configuration no path rule may cover: a `.claude`, `.git`, `.husky`, `.github` or `.vscode`
 * segment, `.mcp.json`, `CLAUDE.md` or `AGENTS.md`, or a dot segment holding a glob (it could match any of them).
 */
function configPath(p: string): boolean {
  return lowerSegments(p).some((s) => CONFIG_SEGMENTS.has(s) || SENSITIVE_NAMES.has(s) || (s.startsWith('.') && GLOB_CHARS.test(s)));
}

/**
 * True for a file that runs code later, so no edit rule may cover it: `.husky/`, `.github/`, `.vscode/`, `scripts/`,
 * `package.json`, `Makefile`, `.env*`, `.git*` (hooks, `.gitattributes` filters, `.gitmodules`) and `Library/LaunchAgents`.
 */
function runsCodeLater(p: string): boolean {
  const segs = lowerSegments(p);
  const base = segs[segs.length - 1] ?? '';
  if (base === 'package.json' || base === 'makefile' || base === 'gnumakefile') return true;
  if (segs.some((s, i) => s === 'launchagents' && segs[i - 1] === 'library')) return true;
  return segs.some((s) => CONFIG_SEGMENTS.has(s) || s === 'scripts' || s.startsWith('.git') || s.startsWith('.env'));
}

/** No Edit rule for configuration or a file that runs code later (`shown` is hq-relative inside the hq), nor for a sensitive path (see sensitivePath); `abs` is the absolute path. */
const noEditRule = (shown: string, abs: string, cwd?: string): boolean => configPath(shown) || runsCodeLater(shown) || sensitivePath(abs, cwd);

/** The permission rule "Always allow" would propose for this call, or '' when none is safe. Never a glob. */
export function ruleFor(toolName: string, input: unknown, cwd: string): string {
  const i = obj(input);
  if (toolName === 'Bash') {
    const c = str(i.command);
    return c ? bashRule(c, cwd) : '';
  }
  if (toolName === 'Skill') {
    const s = str(i.skill) ?? str(i.name);
    return s ? `Skill(${s})` : 'Skill';
  }
  if (toolName === 'WebFetch') {
    const u = str(i.url);
    if (u) {
      try {
        return `WebFetch(domain:${new URL(u).hostname})`;
      } catch {
        // fall through
      }
    }
    return 'WebFetch';
  }
  if (EDIT_TOOLS.has(toolName)) {
    const p = editPath(i);
    if (!p) return '';
    const abs = path.resolve(cwd, p);
    const rel = path.relative(cwd, abs);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    // Inside the hq: "/relative/path". Outside: "//absolute/path" (the absolute path already starts with a slash).
    const shown = (inside ? rel : abs).split(path.sep).join('/');
    if (noEditRule(shown, abs, cwd) || GLOB_CHARS.test(shown) || /[\r\n]/.test(shown)) return '';
    return `Edit(/${shown})`;
  }
  if (READ_TOOLS.has(toolName)) return '';
  if (toolName === 'Artifact') {
    const action = artifactAction(i).action;
    return SAFE_ARTIFACT_ACTIONS.includes(action) ? artifactRuleFor(action) : '';
  }
  // A question needs the user's answers: a rule would auto-allow future questions with none.
  if (toolName === ASK_USER_QUESTION) return '';
  return toolName;
}

// ---------- validating ----------

const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_:.-]*)(?:\((.+)\))?$/;

function validBashRule(arg: string, cwd?: string): boolean {
  let body = arg.trim();
  if (!body || body.length > MAX_LINE) return false;
  let prefix = false;
  if (body.endsWith(':*')) {
    prefix = true;
    body = body.slice(0, -2).trimEnd();
  } else if (body.endsWith(' *')) {
    prefix = true;
    body = body.slice(0, -2).trimEnd();
  }
  if (!body || body.includes('*') || UNSAFE_LINE.test(body) || ASSIGN.test(body)) return false;
  const w = body.split(/\s+/);
  const prog = w[0];
  if (prog !== '.' && !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(prog)) return false;
  const scan = scanBashArgs([w], cwd);
  if (scan.sensitive) return false;
  if (prefix) {
    if (isDangerousProgram(prog) || isExactOnlyWords(w) || scan.readerOutside) return false;
    if (MULTI_LEVEL.has(prog) && w.length < 2) return false;
  }
  return true;
}

function validEditRule(arg: string, cwd?: string): boolean {
  const a = arg.trim();
  if (!a || GLOB_CHARS.test(a) || a.startsWith('~') || a.endsWith('/') || /[\r\n]/.test(a)) return false;
  if (a.split('/').includes('..')) return false;
  const abs = a.startsWith('//');
  const n = path.posix.normalize(abs ? a.slice(1) : a);
  if (n === '/' || n === '.') return false;
  // An absolute rule inside the hq is checked on its hq-relative part, so the hq's own location never matters.
  const shown = abs && cwd && inHq(n, cwd) ? path.posix.relative(hqBase(cwd), n) : n;
  if (configPath(shown) || runsCodeLater(shown)) return false;
  if (sensitivePath(abs ? n : cwd ? path.join(cwd, n) : n, cwd)) return false;
  if (cwd) {
    const target = abs ? n : path.join(cwd, n);
    try {
      if (fs.statSync(target).isDirectory()) return false;
    } catch {
      // not there yet: fine
    }
  }
  return true;
}

/** True when `rule` is acceptable as an edited "Always allow" rule for a request of `toolName`: nothing a proposal could not be. */
export function validateRule(rule: unknown, toolName: string, cwd?: string): rule is string {
  if (typeof rule !== 'string') return false;
  const r = rule.trim();
  if (!r || /[\r\n]/.test(r)) return false;
  const m = RULE_SHAPE.exec(r);
  if (!m) return false;
  const ruleTool = m[1];
  const arg = m[2];
  if (EDIT_TOOLS.has(toolName)) {
    if (!EDIT_TOOLS.has(ruleTool)) return false;
    return arg !== undefined && validEditRule(arg, cwd);
  }
  if (ruleTool !== toolName) return false;
  if (ruleTool === 'Bash') return arg !== undefined && validBashRule(arg, cwd);
  if (ruleTool === 'Artifact') return SAFE_ARTIFACT_ACTIONS.some((a) => artifactRuleFor(a) === r);
  if (READ_TOOLS.has(ruleTool)) return false;
  return true;
}

// ---------- anchoring path rules for the command line ----------

/**
 * In a settings file `Tool(/x)` is relative to the file's folder; on the command line its meaning is not guaranteed.
 * Rewrites a path rule whose argument starts with a single `/` into `Tool(//<baseDir>/x)`. Everything else is unchanged.
 */
export function anchorPathRule(rule: string, baseDir: string): string {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m) return rule;
  const [, tool, arg] = m;
  if (!PATH_TOOLS.has(tool) || arg === undefined) return rule;
  if (!arg.startsWith('/') || arg.startsWith('//')) return rule;
  const base = path.resolve(baseDir).split(path.sep).join('/').replace(/\/+$/, '');
  return `${tool}(/${base}${arg})`;
}

// ---------- matching deny rules ----------

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function pathMatches(pattern: string, file: string, cwd: string): boolean {
  let pat = pattern.trim();
  let target: string;
  if (pat.startsWith('//')) {
    pat = pat.slice(1);
    target = path.resolve(cwd, file);
  } else if (pat.startsWith('~/')) {
    pat = os.homedir().split(path.sep).join('/') + pat.slice(1);
    target = path.resolve(cwd, file);
  } else if (pat.startsWith('/') && !pat.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
    // "/x" is relative to the hq root; a real absolute path inside the hq is also accepted below
    pat = pat.slice(1);
    target = relPath(path.resolve(cwd, file), cwd);
  } else {
    if (pat.startsWith('./')) pat = pat.slice(2);
    target = relPath(path.resolve(cwd, file), cwd);
    if (path.isAbsolute(pat)) target = path.resolve(cwd, file);
  }
  target = target.split(path.sep).join('/');
  return globToRegex(pat).test(target);
}

function inputPath(toolName: string, i: Obj): string | null {
  if (EDIT_TOOLS.has(toolName)) return editPath(i);
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return str(i.file_path) ?? str(i.path);
  return null;
}

function sameToolFamily(ruleTool: string, toolName: string): boolean {
  if (EDIT_TOOLS.has(ruleTool)) return EDIT_TOOLS.has(toolName);
  return ruleTool === toolName;
}

/** Does `rule` match one Bash command part (already split)? */
function bashPartMatches(rule: string, part: string): boolean {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m || m[1] !== 'Bash') return false;
  if (m[2] === undefined) return true;
  let inner = m[2].trim();
  const w = normalizeWords(part);
  if (w.length === 0) return false;
  const text = w.join(' ');
  if (inner.endsWith(':*')) inner = inner.slice(0, -2).trimEnd();
  else if (inner.endsWith(' *')) inner = inner.slice(0, -2).trimEnd();
  else return text === inner || normalizeWords(inner).join(' ') === text;
  if (!inner) return false;
  const pre = normalizeWords(inner).join(' ');
  return text === pre || text.startsWith(pre + ' ');
}

function nonBashMatches(rule: string, toolName: string, input: Obj, cwd: string): boolean {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m) return false;
  const [, ruleTool, arg] = m;
  if (arg === undefined) {
    return sameToolFamily(ruleTool, toolName) || (ruleTool.startsWith('mcp__') && toolName.startsWith(ruleTool + '__'));
  }
  if (!sameToolFamily(ruleTool, toolName)) return false;
  if (toolName === 'Artifact') {
    // `Artifact(action:x)` matches the action x; a trailing `*` makes it a prefix. Any other key never matches.
    const a = /^action:(.*)$/.exec(arg.trim());
    if (!a) return false;
    const action = artifactAction(input).action;
    const want = a[1].trim(); // `Artifact(action: delete)` is the same rule
    return want.endsWith('*') ? action.startsWith(want.slice(0, -1).trimEnd()) : action === want;
  }
  if (toolName === 'WebFetch') {
    if (!arg.startsWith('domain:')) return false;
    const u = str(input.url);
    if (!u) return false;
    try {
      return new URL(u).hostname === arg.slice(7);
    } catch {
      return false;
    }
  }
  if (toolName === 'Skill') {
    const s = str(input.skill) ?? str(input.name);
    if (!s) return false;
    return arg.endsWith(':*') ? s.startsWith(arg.slice(0, -1)) : s === arg;
  }
  const p = inputPath(toolName, input);
  return p ? pathMatches(arg, p, cwd) : false;
}

/** Is this call hit by a deny rule? For Bash one matching part is enough. Returns the rule or null. */
export function isDenied(rules: readonly string[], toolName: string, input: unknown, cwd: string): string | null {
  const i = obj(input);
  if (toolName === 'Bash') {
    const c = str(i.command);
    if (!c) return null;
    const { parts } = parseBash(c);
    for (const r of rules) if (parts.some((p) => bashPartMatches(r, p))) return r;
    return null;
  }
  return rules.find((r) => nonBashMatches(r, toolName, i, cwd)) ?? null;
}

// ---------- rules from settings files ----------

export interface HqRules {
  allow: string[];
  deny: string[];
  /** Allow rules found only in the committed `.claude/settings.json` (not also in the local file the user writes). */
  sharedOnlyAllow?: string[];
}

function ruleList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '' && !/[\r\n]/.test(x)) : [];
}

/** `permissions.allow` and `permissions.deny` of the hq's settings.json and settings.local.json. Tolerates missing or invalid files. */
export function readHqPermissionRules(hqPath: string): HqRules {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const file of [hqSettingsFile(hqPath), hqLocalSettingsFile(hqPath)]) {
    const perms = asObject(readJsonObject(file).permissions);
    for (const r of ruleList(perms.allow)) if (!allow.includes(r)) allow.push(r);
    for (const r of ruleList(perms.deny)) if (!deny.includes(r)) deny.push(r);
  }
  const local = ruleList(asObject(readJsonObject(hqLocalSettingsFile(hqPath)).permissions).allow);
  const shared = ruleList(asObject(readJsonObject(hqSettingsFile(hqPath)).permissions).allow);
  return { allow, deny, sharedOnlyAllow: shared.filter((r) => !local.includes(r)) };
}

// ---------- filtering the hq's allow rules ----------

/**
 * The one rule of the plugin's generated set that the strict check would otherwise drop: reading the plugin's own files.
 * No Bash rule is ever exempt: a wildcard inside a shell or interpreter command spans its arguments, so it allows any code.
 */
const PLUGIN_READ_RULE = 'Read(~/.claude/plugins/cache/ceo-of-agents/**)';

const hqBase = (hqPath: string): string => path.resolve(hqPath).split(path.sep).join('/').replace(/\/+$/, '');

function inHq(abs: string, hqPath: string): boolean {
  const p = path.posix.normalize(abs);
  const base = hqBase(hqPath);
  return p === base || p.startsWith(base + '/');
}

function allowRuleOk(rule: string, hqPath: string): boolean {
  const r = rule.trim();
  if (r === PLUGIN_READ_RULE) return true;
  const m = RULE_SHAPE.exec(r);
  if (!m) return false;
  const [, tool, rawArg] = m;
  if (tool === 'Artifact') return SAFE_ARTIFACT_ACTIONS.some((a) => artifactRuleFor(a) === r); // only the exact safe rules
  if (rawArg === undefined) return false; // bare tool name, mcp__ server or Skill: too broad
  const arg = rawArg.trim();
  if (!arg || /^[*:\s]+$/.test(arg)) return false;
  if (tool === 'Bash') {
    // `gh ... -R owner/*` (a repo owner pattern) is the one wildcard allowed inside a command, and only for gh.
    const plain = /^gh\s/.test(arg) ? arg.replace(/(-R [A-Za-z0-9_.-]+\/)\*(?=\s|$)/, '$1X') : arg;
    return validBashRule(plain, hqPath);
  }
  if (tool === 'WebFetch') return /^domain:[A-Za-z0-9][A-Za-z0-9.-]*$/.test(arg);
  if (tool === 'Skill') return /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?(?::\*)?$/.test(arg);
  if (PATH_TOOLS.has(tool)) {
    const a = anchorPathRule(r, hqPath).slice(tool.length + 1, -1).trim();
    if (a.startsWith('~') || a.split('/').includes('..')) return false;
    if (a.startsWith('//') && !inHq(a.slice(1), hqPath)) return false;
    if (!a.startsWith('//') && a.startsWith('/')) return false;
    // Same check as an edited rule: never configuration, and for edits never a file that runs code later.
    const shown = a.startsWith('//') ? path.posix.relative(hqBase(hqPath), path.posix.normalize(a.slice(1))) : a;
    if (configPath(shown)) return false;
    return !(EDIT_TOOLS.has(tool) && runsCodeLater(shown));
  }
  return false; // WebSearch, mcp__*, Task, ...: never pre-approved from a settings file
}

/**
 * The hq's allow rules the app passes to Claude Code: a rule from a committed (or local) settings file is a pre-approval, so
 * only narrow ones are kept. Dropped: bare tool names, wildcard-only or program-wide Bash rules, MCP rules, WebSearch, WebFetch
 * without a domain, path rules outside the hq or naming configuration, and edit rules for files that run code later.
 * The plugin's read rule for its own files passes; no Bash rule is exempt.
 */
export function filterAllowRules(rules: readonly string[], hqPath: string): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const r of rules) (allowRuleOk(r, hqPath) ? kept : dropped).push(r);
  return { kept, dropped };
}

/**
 * True for an exact Bash rule of a program that only ever gets exact rules (shells, interpreters, rm, git push, ...).
 * Such a rule is fine when the user wrote it with "Always allow" (settings.local.json), but it arrives with a pull
 * when it sits in the committed settings.json, so it is not honoured from there.
 */
function dangerousExactBash(rule: string): boolean {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m || m[1] !== 'Bash' || m[2] === undefined) return false;
  const w = m[2].trim().split(/\s+/);
  return isDangerousProgram(w[0]) || isExactOnlyWords(w);
}

/** filterAllowRules over both hq files: rules only in the committed file also lose exact rules of dangerous programs. */
export function filterHqAllowRules(hq: HqRules, hqPath: string): { kept: string[]; dropped: string[] } {
  const shared = new Set(hq.sharedOnlyAllow ?? []);
  const { kept, dropped } = filterAllowRules(hq.allow, hqPath);
  const out = { kept: [] as string[], dropped: [...dropped] };
  for (const r of kept) (shared.has(r) && dangerousExactBash(r) ? out.dropped : out.kept).push(r);
  return out;
}

/**
 * The allow rules the app ignores, split by the file they are written in: `local` is the git-ignored
 * `settings.local.json` (the user's own, written by "Always allow"; the app may clean it up), `project` is the committed
 * `settings.json` (the hq's own; never changed by the app). Same checks as `filterHqAllowRules`; a rule written in both
 * files shows in both groups.
 */
export function droppedRulesBySource(hqPath: string): { local: string[]; project: string[] } {
  const local = ruleList(asObject(readJsonObject(hqLocalSettingsFile(hqPath)).permissions).allow);
  const shared = ruleList(asObject(readJsonObject(hqSettingsFile(hqPath)).permissions).allow);
  const localSet = new Set(local);
  const project = filterAllowRules(shared, hqPath);
  // The broad Artifact and AskUserQuestion rules are reported apart (`broadAllowRulesBySource`).
  return {
    local: filterAllowRules(local, hqPath).dropped.filter((r) => !isBroadSelfAllowRule(r)),
    project: [...project.dropped, ...project.kept.filter((r) => !localSet.has(r) && dangerousExactBash(r))].filter((r) => !isBroadSelfAllowRule(r)),
  };
}

/**
 * True for an allow rule that Claude Code itself would honour (sessions run with `--setting-sources project,local`, so it
 * reads both hq files whatever the app filters out of `--allowedTools`) and that would let a card-only tool run with no
 * card: any `Artifact` rule other than the three safe actions (a bare `Artifact`, `Artifact(*)`, `Artifact(action:*)`,
 * `Artifact(action:publish)`, ...) and any `AskUserQuestion` rule (it would answer a question without asking).
 */
export function isBroadSelfAllowRule(rule: string): boolean {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m) return false;
  if (m[1] === 'AskUserQuestion') return true;
  if (m[1] !== 'Artifact') return false;
  if (m[2] === undefined) return true;
  const a = /^action:\s*(.*?)\s*$/.exec(m[2].trim());
  return !(a && SAFE_ARTIFACT_ACTIONS.includes(a[1]));
}

/** The broad Artifact / AskUserQuestion allow rules (`isBroadSelfAllowRule`) written in each hq settings file. */
export function broadAllowRulesBySource(hqPath: string): { local: string[]; project: string[] } {
  const pick = (file: string): string[] => ruleList(asObject(readJsonObject(file).permissions).allow).filter(isBroadSelfAllowRule);
  return { local: pick(hqLocalSettingsFile(hqPath)), project: pick(hqSettingsFile(hqPath)) };
}

/**
 * Removes from `<hq>/.claude/settings.local.json` exactly the `permissions.allow` rules that `filterAllowRules` drops.
 * Every other key and rule (and their order) stays; the write is atomic. Never reads or writes `.claude/settings.json`.
 * Throws when the file is missing or is not valid JSON (nothing is written). Returns the number of rules removed
 * (0: the file is not rewritten).
 */
export function removeDroppedLocalRules(hqPath: string): number {
  if (!fs.existsSync(hqLocalSettingsFile(hqPath))) throw new Error('settings.local.json was not found.');
  let removed = 0;
  updateHqLocalSettings(hqPath, (data) => {
    const perms = asObject(data.permissions);
    if (!Array.isArray(perms.allow)) return false;
    const isDropped = (r: unknown): boolean => typeof r === 'string' && ruleList([r]).length > 0 && filterAllowRules([r], hqPath).dropped.length > 0;
    const next = perms.allow.filter((r) => !isDropped(r));
    removed = perms.allow.length - next.length;
    if (removed === 0) return false;
    perms.allow = next;
    return true;
  });
  return removed;
}

/** Only `permissions.deny` of a settings file (the user's own): the one key the app reads from it besides mode and effort. */
export function readDenyRules(file: string): string[] {
  return ruleList(asObject(readJsonObject(file).permissions).deny);
}
