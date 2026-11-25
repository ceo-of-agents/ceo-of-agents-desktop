// The connectors of an org, read-only: the grants per department (org.yaml `departments[].connectors`), what each agent
// file's `tools:` line holds, the org's forbidden connectors (org.yaml and, on this computer, accounts.local.yaml: patterns
// only, see forbidden-connectors.ts) and the servers of the hq's own `.mcp.json`.
// This module has no write path: a grant, a change or a removal is a request to the chief of staff, who prepares a
// decision card (the plugin's `departments` skill). It never reads user-scope or account connectors (`~/.claude.json`,
// Claude Code's global state) and never runs `claude mcp list`. From `.mcp.json` it takes the server names only.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { t } from '../../shared/strings';
import type { AvailableConnector, ConnectorDepartment, ConnectorsInfo, McpLockReason } from '../../shared/types';
import { yamlDetail, parseFrontmatter, readCapped } from './org-chart';
import { matchesPattern } from './pattern';
import { readForbiddenPatterns } from './forbidden-connectors';

export { matchesPattern };

const ADVISORY = new Set(['legal', 'finance', 'tax']);
const SERVER_NAME = /^[A-Za-z0-9_.-]+$/;
const safeSegment = (s: string): boolean => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Claude Code turns every character of a server name outside `[A-Za-z0-9_-]` into `_` in tool names, so a grant pattern
 * cannot reliably name a server whose key has a `.`: such a server is never granted (loader) nor offered (settings).
 */
export const nameHasDot = (server: string): boolean => server.includes('.');

/**
 * True when a forbidden pattern rules out the whole server: the bare server (`mcp__<server>`), a wildcard that matches the
 * bare server or `mcp__<server>__*` (`mcp__no*`, `mcp__*`, `*`), or a tool of the server (`mcp__<server>__send`).
 * Shared by the settings view and the loader, so both agree.
 */
export function isForbiddenServer(forbidden: readonly string[], server: string): boolean {
  const bare = `mcp__${server}`;
  const all = `${bare}__*`;
  return forbidden.some((f) => f === bare || matchesPattern(f, bare) || matchesPattern(f, all) || f.startsWith(`${bare}__`));
}

/** A list of strings from YAML (a string or a list), trimmed, no empties, no duplicates. */
function strings(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const s = str(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The entries of a `tools:` value (a comma string or a list), trimmed, no empties. Commas inside parentheses (`Agent(a, b)`) do not split. */
function toolEntries(tools: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(tools)) for (const x of tools) parts.push(str(x));
  else {
    const text = str(tools);
    let depth = 0;
    let cur = '';
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
  }
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** The `mcp__` entries of a `tools:` value (a comma string or a list). */
export function mcpToolEntries(tools: unknown): string[] {
  return [...new Set(toolEntries(tools).filter((e) => e.startsWith('mcp__')))];
}

export function emptyConnectors(error: string | null = null): ConnectorsInfo {
  return { departments: [], forbidden: [], forbiddenLocal: [], forbiddenProblems: [], forbiddenWarnings: [], available: [], notGrantable: [], session: emptySession(), error };
}

/** The session part of `ConnectorsInfo` before any chat of the org has started (`OrgManager.getConnectors` fills it in). */
export function emptySession(): ConnectorsInfo['session'] {
  return { started: false, loaded: [], keptOut: [], claudeAiOff: false, forbiddenRules: [], mcpLocked: false };
}

function reason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].trim();
}

/** The server names of `.mcp.json` text (keys of `mcpServers` that are plain names). Values are never read into the result. */
export function mcpServerNames(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const k of Object.keys(obj(obj(doc).mcpServers))) if (SERVER_NAME.test(k) && !names.includes(k)) names.push(k);
  return names;
}

/**
 * The text of the hq's `.mcp.json`, or null when there is none to trust: it must be a regular file (a symlink or a folder
 * is refused outright, so the app never reads a file the hq only points at) whose real path is inside the hq's real path.
 * Over 256 KB it is null too.
 */
export function readMcpJson(hqPath: string): string | null {
  const file = path.join(hqPath, '.mcp.json');
  if (!fs.lstatSync(file).isFile()) return null;
  const rel = path.relative(fs.realpathSync(hqPath), fs.realpathSync(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return readCapped(file);
}

/** The server names of the hq's `.mcp.json` (see `readMcpJson`); empty when there is none to trust or it cannot be read. Never throws. */
export function hqMcpServerNames(hqPath: string): string[] {
  try {
    const body = readMcpJson(hqPath);
    return body === null ? [] : mcpServerNames(body);
  } catch {
    return [];
  }
}

/**
 * What the agent file of `agent` says about tools. The file is the one whose frontmatter `name` is the agent (what `--agent` loads),
 * else the one called `<agent>.md` (as the org chart does). `found` is false when there is none or it cannot be read (over 256 KB,
 * unreadable); `mcp` its `mcp__` entries; `lock` why the agent is not limited per tool: `no-tools-line` (no file found or readable, no line,
 * an empty one), `all-tools` (an entry that is exactly `*`: every tool, MCP ones included; `mcp__x__*` is not one), else null.
 */
export function agentToolsLine(hqPath: string, agent: string): { found: boolean; lock: McpLockReason | null; mcp: string[] } {
  const body = readAgentFile(hqPath, agent);
  if (body === null) return { found: false, lock: 'no-tools-line', mcp: [] };
  const tools = parseFrontmatter(body).data.tools;
  const entries = toolEntries(tools);
  return { found: true, lock: entries.length === 0 ? 'no-tools-line' : entries.includes('*') ? 'all-tools' : null, mcp: mcpToolEntries(tools) };
}

/** The text of a file that is a plain file (no symlink, no folder) whose real path is inside `dir`, or null when it is over the cap. Throws like `readFileSync`. */
function readPlainInside(dir: string, file: string): string | null {
  if (!fs.lstatSync(file).isFile()) throw new Error('not a plain file');
  const rel = path.relative(fs.realpathSync(dir), fs.realpathSync(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the agents folder');
  return readCapped(file);
}

/**
 * The text of the agent file of `agent` (the file whose frontmatter `name` is the agent, else `<agent>.md`), or null when there is none or
 * it cannot be read (over 256 KB, unreadable). With `plainOnly`, a symlink or a file whose real path leaves `.claude/agents/` is not read. Never throws.
 */
export function readAgentFile(hqPath: string, agent: string, opts: { plainOnly?: boolean } = {}): string | null {
  const dir = path.join(hqPath, '.claude', 'agents');
  const read = (file: string): string | null => (opts.plainOnly ? readPlainInside(dir, file) : readCapped(file));
  const named = (body: string | null): body is string => body !== null && str(parseFrontmatter(body).data.name) === agent;
  let stem: string | null = null;
  if (safeSegment(agent)) {
    try {
      stem = read(path.join(dir, `${agent}.md`));
    } catch {
      // no file called after the agent
    }
  }
  let body = named(stem) ? stem : null;
  if (body === null) {
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
        try {
          const text = read(path.join(dir, ent.name));
          if (named(text)) {
            body = text;
            break;
          }
        } catch {
          // unreadable: not this one
        }
      }
    } catch {
      // no agents folder
    }
  }
  return body ?? stem;
}

/** Reads the connectors of the hq at `hqPath`. Never throws: an unreadable org.yaml is `error` on empty lists. */
export function readConnectors(hqPath: string): ConnectorsInfo {
  let text: string;
  try {
    const read = readCapped(path.join(hqPath, 'org.yaml'));
    if (read === null) return emptyConnectors(t('orgChart.err.tooBig'));
    text = read;
  } catch (e) {
    return emptyConnectors((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? t('orgChart.err.missing') : t('orgChart.err.unreadable', { reason: reason(e) }));
  }
  if (!text.trim()) return emptyConnectors(t('orgChart.err.empty'));
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return emptyConnectors(yamlDetail(e));
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return emptyConnectors(t('orgChart.err.shape'));
  const root = obj(doc);

  const patterns = readForbiddenPatterns(hqPath);
  const forbidden = patterns.org;
  // Servers a forbidden pattern covers (the org's or this computer's) are neither granted nor offered.
  const allForbidden = [...forbidden, ...patterns.local];
  const departments: ConnectorDepartment[] = [];
  for (const raw of Array.isArray(root.departments) ? root.departments : []) {
    const d = obj(raw);
    const id = str(d.id);
    if (!id) continue;
    const agent = str(d.agent) || id;
    const file = agentToolsLine(hqPath, agent);
    departments.push({
      id,
      displayName: str(d.display_name) || id,
      agent,
      advisory: ADVISORY.has(str(d.from_catalog)),
      granted: strings(d.connectors),
      inAgentFile: file.mcp,
      mcpLock: file.lock,
    });
  }

  const available: AvailableConnector[] = [];
  const notGrantable: string[] = [];
  for (const server of hqMcpServerNames(hqPath)) {
    if (isForbiddenServer(allForbidden, server)) continue;
    if (nameHasDot(server)) notGrantable.push(server);
    else available.push({ server, pattern: `mcp__${server}__*` });
  }
  return { departments, forbidden, forbiddenLocal: patterns.local, forbiddenProblems: patterns.problems, forbiddenWarnings: [], available, notGrantable, session: emptySession(), error: null };
}
