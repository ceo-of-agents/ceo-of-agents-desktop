// Turns a tool call into one plain-language line for non-technical users. Pure: no I/O.
import path from 'node:path';
import { t } from '../../shared/strings';
import { artifactActivity, artifactAction } from './artifact-actions';

const MAX = 80;

function truncate(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= MAX ? one : `${one.slice(0, MAX - 1).trimEnd()}…`;
}

function str(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** The app's own permission tool: its call is never a step of the turn. */
export function isAppTool(name: string): boolean {
  return name === 'mcp__coa__permission_prompt';
}

/** Path relative to cwd when inside it, else the base name (never an absolute path). */
function shortPath(p: string, cwd: string): string {
  if (!p) return '';
  if (cwd && path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    return path.basename(p);
  }
  if (path.isAbsolute(p)) return path.basename(p);
  const norm = path.normalize(p);
  return norm.startsWith('..') ? path.basename(p) : norm;
}

/** Removes leading `cd <dir> &&` and env assignments, so the first real command is left. */
function firstCommand(cmd: string): string {
  let s = cmd.trim();
  for (let i = 0; i < 10; i++) {
    const cd = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(s);
    if (cd) {
      s = s.slice(cd[0].length);
      continue;
    }
    const env = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(s);
    if (env) {
      s = s.slice(env[0].length);
      continue;
    }
    break;
  }
  return s;
}

function describeCommand(command: string): string {
  const cmd = firstCommand(command);
  const git = /^git\s+(?:-C\s+\S+\s+)?(pull|fetch|push|commit)\b/.exec(cmd);
  if (git) {
    if (git[1] === 'push') return t('activity.cmd.push');
    if (git[1] === 'commit') return t('activity.cmd.commit');
    return t('activity.cmd.pull');
  }
  if (/^npm\s+(?:test|run\s+(?:test|check))(?:\s|$)/.test(cmd)) return t('activity.cmd.tests');
  if (/^gh(\s|$)/.test(cmd)) {
    const gh = /^gh\s+(?:(?:-R|--repo)\s+\S+\s+)?(issue|pr)\s+(create|merge|close)\b/.exec(cmd);
    if (gh?.[2] === 'create') return t(gh[1] === 'issue' ? 'activity.cmd.ghIssueCreate' : 'activity.cmd.ghPrCreate');
    if (gh?.[2] === 'merge' && gh[1] === 'pr') return t('activity.cmd.ghPrMerge');
    if (gh?.[2] === 'close') return t('activity.cmd.ghClose');
    return t('activity.cmd.gh');
  }
  return t('activity.cmd.other');
}

function describeSkill(raw: string): string {
  const name = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  const known = ['session-start', 'intake', 'record-decision', 'weekly-brief', 'hq-version', 'departments', 'initiatives', 'product-repos'];
  return known.includes(name) ? t(`activity.skill.${name}`) : t('activity.other');
}

/** Agents that are workers or built-in helpers; any other agent name is a department. */
const HELPERS = new Set(['reader', 'worker', 'general-purpose', 'explore', 'plan']);

function describeAgent(agent: string): string {
  if (!agent || HELPERS.has(agent.toLowerCase())) return t('activity.agentHelper');
  return t('activity.agentDept', { persona: agent.charAt(0).toUpperCase() + agent.slice(1) });
}

/** One plain line (max about 80 characters) for what a tool call does. Never a raw tool name. */
export function describeTool(name: string, input: unknown, _cwd?: string): string {
  const o: Record<string, unknown> = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  let line: string;
  switch (name) {
    case 'Bash':
      line = describeCommand(str(o, 'command'));
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = path.basename(str(o, 'file_path', 'notebook_path', 'path'));
      const key = name === 'Read' ? 'activity.read' : 'activity.update';
      line = file ? t(key, { file }) : t(`${key}NoFile`);
      break;
    }
    case 'Grep':
    case 'Glob':
      line = t('activity.search');
      break;
    case 'WebFetch':
    case 'WebSearch':
      line = t('activity.web');
      break;
    case 'TodoWrite':
      line = t('activity.todo');
      break;
    case 'Agent':
    case 'Task':
      line = describeAgent(str(o, 'subagent_type'));
      break;
    case 'Skill':
      line = describeSkill(str(o, 'skill', 'name'));
      break;
    case 'Artifact':
      line = artifactActivity(input);
      break;
    case 'AskUserQuestion':
      line = t('activity.question.ask');
      break;
    default:
      line = t('activity.other');
  }
  return truncate(line);
}

const MAX_DETAIL = 100;
const MAX_QUERY = 60;

/** Programs whose second word is a subcommand worth showing (`git push`, `npm run`, `gh pr`). Any other program shows alone. */
const WITH_SUBCOMMAND = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'kubectl', 'cargo', 'go', 'brew', 'pip', 'pip3', 'claude', 'swift', 'terraform']);
const PLAIN_PROGRAM = /^[A-Za-z0-9._+-]{1,40}$/;
const PLAIN_SUBCOMMAND = /^[a-z][a-z-]{0,24}$/;

/**
 * The program of a shell command, plus its subcommand for the programs above. Never an argument: commands carry
 * tokens, passwords and URLs with credentials, and this text is stored in the thread log and shown in the thread.
 */
function commandName(command: string): string {
  const words = firstCommand(command).split(/\s+/).filter(Boolean);
  const program = (words[0] ?? '').replace(/^["']|["']$/g, '').split('/').pop() ?? '';
  if (!PLAIN_PROGRAM.test(program) || program.includes('=')) return '';
  if (!WITH_SUBCOMMAND.has(program)) return program;
  const rest = program === 'git' && words[1] === '-C' ? words.slice(3) : words.slice(1);
  const sub = rest[0] ?? '';
  return PLAIN_SUBCOMMAND.test(sub) ? `${program} ${sub}` : program;
}

/** The host of a URL, never its user, password, path or query. Empty when it is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Cut to `max` characters with an ellipsis. */
function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The tool and its main argument for technical readers, for example `Read · company/state.md`. Stored in the thread
 * log, so it never holds what can be a secret: Bash gives the program and subcommand only, WebFetch the host only.
 */
export function describeDetail(name: string, input: unknown, cwd?: string): string {
  const o: Record<string, unknown> = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  let arg = '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      arg = shortPath(str(o, 'file_path', 'notebook_path', 'path'), cwd ?? '');
      break;
    case 'Bash':
      arg = commandName(str(o, 'command'));
      break;
    case 'Grep':
    case 'Glob':
      arg = str(o, 'pattern');
      break;
    case 'WebFetch':
      arg = hostOf(str(o, 'url'));
      break;
    case 'WebSearch':
      arg = cut(str(o, 'query'), MAX_QUERY);
      break;
    case 'Skill':
      arg = str(o, 'skill', 'name');
      break;
    case 'Agent':
    case 'Task':
      arg = str(o, 'subagent_type');
      break;
    case 'Artifact': {
      const a = artifactAction(input);
      arg = a.action ? (a.target && a.action !== 'publish' ? `${a.action} · ${a.target}` : a.action) : '';
      break;
    }
  }
  return cut(arg ? `${name} · ${arg}` : name, MAX_DETAIL);
}
