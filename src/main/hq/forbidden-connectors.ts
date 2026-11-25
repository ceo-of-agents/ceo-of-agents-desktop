// Forbidden connectors as Claude Code deny rules, and what they imply for a chat process. Pure and non-throwing.
// Sources: `accounts.forbidden_connectors` of the hq's org.yaml and the top-level `forbidden_connectors` of the hq's
// accounts.local.yaml (this computer only). From the second file ONLY the `pattern` of each item is read: the file also
// holds local paths and account labels, which never leave this module (a test checks that).
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { own } from '../../shared/own';
import { t } from '../../shared/strings';
import { matchesPattern } from './pattern';
import { readCapped } from './org-chart';

export interface ForbiddenPatterns {
  /** `accounts.forbidden_connectors` of org.yaml. */
  org: string[];
  /** `forbidden_connectors` of accounts.local.yaml. */
  local: string[];
  /**
   * What is wrong with the lists: org.yaml missing or unreadable, a file that is not valid, a list that is not a list, an item that is
   * not a pattern (a missing accounts.local.yaml is fine). Each one locks MCP in the org's chats (see `OrgSession`): nothing is dropped silently.
   */
  problems: string[];
}

/** The app's own permission server: it is never kept from starting. */
const APP_SERVER = 'coa';
const PROMPT_TOOL = 'mcp__coa__permission_prompt';
const CLAUDE_AI_PREFIX = 'mcp__claude_ai_';
const MAX_RULE = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The patterns of a YAML list: strings, or objects of which only `pattern` is read. Trimmed, no duplicates. Null or absent is
 * an empty list; anything else that is not a list, and an item that is not a pattern (not a text, no text `pattern`, empty), is a problem.
 */
function patternsOf(v: unknown, file: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(t('connectors.forbidden.list.shape', { file }));
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    const raw = typeof item === 'string' ? item : isObj(item) ? own(item, 'pattern') : undefined;
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) problems.push(t('connectors.forbidden.item.bad', { n: i + 1, file }));
    else if (!out.includes(s)) out.push(s);
  });
  return out;
}

function reason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].trim();
}

/** Reads one YAML file and returns its parsed top-level value; `missing` for a file that is not there. */
function readYaml(file: string, label: string): { doc: unknown; missing: boolean; problem: string | null } {
  let text: string | null;
  try {
    text = readCapped(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { doc: null, missing: true, problem: null };
    return { doc: null, missing: false, problem: t('connectors.forbidden.file.unreadable', { file: label, reason: reason(e) }) };
  }
  if (text === null) return { doc: null, missing: false, problem: t('connectors.forbidden.file.tooBig', { file: label }) };
  try {
    return { doc: parseYaml(text), missing: false, problem: null };
  } catch (e) {
    return { doc: null, missing: false, problem: t('connectors.forbidden.file.yaml', { file: label, reason: reason(e) }) };
  }
}

/** The forbidden patterns of the hq at `hqPath`. Never throws; whatever cannot be read as a list of patterns is a problem. */
export function readForbiddenPatterns(hqPath: string): ForbiddenPatterns {
  const out: ForbiddenPatterns = { org: [], local: [], problems: [] };
  const org = readYaml(path.join(hqPath, 'org.yaml'), 'org.yaml');
  if (org.problem) out.problems.push(org.problem);
  else if (org.missing) out.problems.push(t('connectors.forbidden.file.missing', { file: 'org.yaml' }));
  else if (!isObj(org.doc)) out.problems.push(t('connectors.forbidden.file.shape', { file: 'org.yaml' }));
  else {
    const accounts = own(org.doc, 'accounts');
    if (accounts === undefined || accounts === null) out.org = [];
    else if (!isObj(accounts)) out.problems.push(t('connectors.forbidden.accounts.shape'));
    else out.org = patternsOf(own(accounts, 'forbidden_connectors'), 'org.yaml', out.problems);
  }
  // accounts.local.yaml is optional: absent or empty is fine.
  const local = readYaml(path.join(hqPath, 'accounts.local.yaml'), 'accounts.local.yaml');
  if (local.problem) out.problems.push(local.problem);
  else if (local.doc === null || local.doc === undefined) out.local = [];
  else if (!isObj(local.doc)) out.problems.push(t('connectors.forbidden.file.shape', { file: 'accounts.local.yaml' }));
  else out.local = patternsOf(own(local.doc, 'forbidden_connectors'), 'accounts.local.yaml', out.problems);
  return out;
}

/**
 * A forbidden pattern as a Claude Code deny rule: `*` alone is `mcp__*`; otherwise it must start with `mcp__` and have
 * something after it. Every character after `mcp__` outside `[A-Za-z0-9_*-]` becomes `_` (Claude Code does the same to a
 * server name in tool names, so `claude.ai Example` becomes `claude_ai_Example`). Null for anything else, or over 200 characters.
 */
export function forbiddenDenyRule(pattern: string): string | null {
  const p = typeof pattern === 'string' ? pattern.trim() : '';
  if (p === '*') return 'mcp__*';
  if (!p.startsWith('mcp__') || p.length <= 'mcp__'.length) return null;
  const rule = 'mcp__' + p.slice('mcp__'.length).replace(/[^A-Za-z0-9_*-]/g, '_');
  return rule.length > MAX_RULE ? null : rule;
}

/** A pattern for a problem text: cut to 80 characters. */
const cut = (p: string): string => (p.length > 80 ? `${p.slice(0, 80)}…` : p);

/**
 * The deny rules of both forbidden lists, deduped. A pattern that cannot become a rule is a problem (quoted, cut to 80
 * characters), never a silent drop.
 */
export function forbiddenDenyRules(f: Pick<ForbiddenPatterns, 'org' | 'local'>): { rules: string[]; problems: string[] } {
  const rules: string[] = [];
  const problems: string[] = [];
  for (const p of [...f.org, ...f.local]) {
    const r = forbiddenDenyRule(p);
    if (r === null) {
      const text = t('connectors.forbidden.pattern.bad', { pattern: cut(p) });
      if (!problems.includes(text)) problems.push(text);
    } else if (!rules.includes(r)) rules.push(r);
  }
  return { rules, problems };
}

/** True when a forbidden rule also covers the app's own permission tool (a denied prompt tool fails closed: forbidden wins). */
export function coversPermissionPrompt(rules: readonly string[]): boolean {
  return rules.some((r) => matchesPattern(r, PROMPT_TOOL));
}

const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));

/**
 * claude.ai connectors never go in `deniedMcpServers`: their real names ("claude.ai <Name>") cannot be derived reliably from a
 * rule, and whether `deniedMcpServers` applies to them is unverified. Their tools are still denied by the deny rule, and
 * `ENABLE_CLAUDEAI_MCP_SERVERS=false` still covers the patterns that cover all of them (`coversAllClaudeAi`).
 */
const isClaudeAiName = (s: string): boolean => s.startsWith('claude.ai ') || s.startsWith('claude_ai_');

/**
 * The real server names of the raw forbidden patterns that are exactly `mcp__<S>` or `mcp__<S>__*` (S: no `*`, no `__`, no
 * control character, at most 200 characters, never the app's own `coa`, never a claude.ai name). `deniedMcpServers` matches the
 * real name (`example.dotted`), not the sanitized one in tool names (`example_dotted`), and case-sensitively (checked with 2.1.327).
 */
export function rawServerNames(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p.startsWith('mcp__') || forbiddenDenyRule(p) === null) continue;
    let s = p.slice('mcp__'.length);
    if (s.endsWith('__*')) s = s.slice(0, -3);
    if (s && s.length <= MAX_RULE && !s.includes('*') && !s.includes('__') && !hasControl(s) && s !== APP_SERVER && !isClaudeAiName(s)) out.add(s);
  }
  return [...out].sort();
}

/**
 * The servers to keep from starting, as `deniedMcpServers` needs them: real names, and only names that really keep a server
 * from starting. `rawNames` (see `rawServerNames`) are used as they are. From a deny rule that is exactly `mcp__<S>` or
 * `mcp__<S>__*` (S a plain name, no `__`, never `coa`, never a claude.ai name) the name is S, unless a known real name
 * (`knownNames`: the hq's `.mcp.json` servers, and `rawNames`) has `mcp__<S>` as its tool prefix: then those real names (a server
 * `example.dotted` is `mcp__example_dotted` in a rule). A wildcard or a tool rule never names a server. Sorted, no duplicates.
 */
export function serversKeptOut(denyRules: readonly string[], rawNames: readonly string[] = [], knownNames: readonly string[] = []): string[] {
  const out = new Set<string>(rawNames);
  const known = [...rawNames, ...knownNames];
  for (const r of denyRules) {
    if (typeof r !== 'string' || !r.startsWith('mcp__')) continue;
    let s = r.slice('mcp__'.length);
    if (s.endsWith('__*')) s = s.slice(0, -3);
    if (!/^[A-Za-z0-9_-]+$/.test(s) || s.includes('__') || s === APP_SERVER || isClaudeAiName(s)) continue;
    const real = known.filter((n) => n !== APP_SERVER && toolPrefix(n) === `mcp__${s}`);
    for (const n of real.length > 0 ? real : [s]) out.add(n);
  }
  return [...out].sort();
}

/** True when a rule covers every claude.ai connector (`*`, `mcp__*`, `mcp__claude*`, `mcp__claude_ai_*`; not `mcp__*__send`). */
export function coversAllClaudeAi(denyRules: readonly string[]): boolean {
  return denyRules.some((r) => {
    const i = typeof r === 'string' ? r.indexOf('*') : -1;
    return i >= 0 && CLAUDE_AI_PREFIX.startsWith(r.slice(0, i)) && /^\*+$/.test(r.slice(i));
  });
}

export interface McpLaunch {
  /** The JSON for `--settings` (`deniedMcpServers`), or null when no server is kept out. */
  settingsJson: string | null;
  /** Environment for the process: `ENABLE_CLAUDEAI_MCP_SERVERS=false` when a rule covers all claude.ai connectors, or when MCP is locked. */
  env: Record<string, string>;
  keptOut: string[];
  /** A forbidden rule covers every claude.ai connector (the lock turns them off too, without this being true). */
  claudeAiOff: boolean;
}

/**
 * What a chat process is started with so that forbidden servers do not start (the deny rules themselves go to `--disallowedTools`).
 * `keptOut`: the real server names (`sessionDeny` computes them; default: those the rules themselves name). `locked`: the "MCP lock"
 * (the process also gets `--strict-mcp-config`, see `buildClaudeArgs`), so claude.ai connectors are off whatever the rules say.
 */
export function mcpLaunch(denyRules: readonly string[], keptOut: readonly string[] = serversKeptOut(denyRules), locked = false): McpLaunch {
  const claudeAiOff = coversAllClaudeAi(denyRules);
  return {
    settingsJson: keptOut.length > 0 ? JSON.stringify({ deniedMcpServers: keptOut.map((serverName) => ({ serverName })) }) : null,
    env: claudeAiOff || locked ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {},
    keptOut: [...keptOut],
    claudeAiOff,
  };
}

/** `mcp__` + the server name with every character outside `[A-Za-z0-9_-]` turned into `_`, as Claude Code does in tool names. */
export const toolPrefix = (serverName: string): string => 'mcp__' + serverName.replace(/[^A-Za-z0-9_-]/g, '_');

export interface ServerBlock {
  /** `all`: every tool of the server is denied; `some`: at least one tool is. */
  kind: 'all' | 'some';
  /** The deny rule that does it. */
  rule: string;
}

/** How the deny rules cut a loaded server: all its tools, some of them, or none (null). */
export function serverBlock(serverName: string, denyRules: readonly string[]): ServerBlock | null {
  const prefix = toolPrefix(serverName);
  const all = denyRules.find((r) => r === prefix || matchesPattern(r, `${prefix}__*`));
  if (all !== undefined) return { kind: 'all', rule: all };
  const some = denyRules.find((r) => r.startsWith(`${prefix}__`));
  return some !== undefined ? { kind: 'some', rule: some } : null;
}

/**
 * Warnings for a forbidden rule that would cut a known server (a loaded one, or one of the hq's `.mcp.json`) if the case were
 * the same: Claude Code matches deny rules case-sensitively (checked with 2.1.327), so such a rule does not apply to it.
 * Warning only, never a lock. At most `cap` (20) texts.
 */
export function caseWarnings(rules: readonly string[], servers: readonly string[], cap = 20): string[] {
  const out: string[] = [];
  const names = [...new Set(servers)];
  for (const rule of rules) {
    for (const server of names) {
      if (out.length >= cap) return out;
      if (serverBlock(server, [rule]) === null && serverBlock(server.toLowerCase(), [rule.toLowerCase()]) !== null) {
        out.push(t('connectors.forbidden.case', { pattern: rule, server }));
      }
    }
  }
  return out;
}
