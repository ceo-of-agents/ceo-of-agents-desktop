import { parse as parseYaml } from 'yaml';
import type { Department, Initiative, InitiativeState, Urgency, WaitingAction, WaitingEntry } from '../../shared/types';

export interface ParsedDepartment {
  id: string;
  agent: string;
  displayName: string;
  fromCatalog: string;
  /** `model` of the department in org.yaml, null if not set. */
  model: string | null;
}

export interface ParsedOrg {
  id: string;
  name: string;
  cosName: string;
  frameworkVersion: string | null;
  chatLanguage: string;
  departments: ParsedDepartment[];
  /** models.cos, models.departments and models.tiers of org.yaml. */
  models: ParsedModels;
}

export interface ParsedModels {
  cos: string | null;
  departments: string | null;
  tiers: string[];
}

const DEFAULT_COS = 'Chief of Staff';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function emptyOrg(): ParsedOrg {
  return { id: '', name: '', cosName: DEFAULT_COS, frameworkVersion: null, chatLanguage: '', departments: [], models: { cos: null, departments: null, tiers: [] } };
}

/** True when org.yaml is valid YAML with a mapping at the top (what `parseOrgYaml` silently turns into an empty org when it is not). */
export function orgYamlReadable(text: string): boolean {
  if (!text.trim()) return false;
  try {
    const doc: unknown = parseYaml(text);
    return !!doc && typeof doc === 'object' && !Array.isArray(doc);
  } catch {
    return false;
  }
}

export function parseOrgYaml(text: string): ParsedOrg {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return emptyOrg();
  }
  const root = obj(doc);
  const org = obj(root.org);
  const departments: ParsedDepartment[] = [];
  if (Array.isArray(root.departments)) {
    for (const raw of root.departments) {
      const d = obj(raw);
      const id = str(d.id);
      if (!id) continue;
      departments.push({
        id,
        agent: str(d.agent) || id,
        displayName: str(d.display_name),
        fromCatalog: str(d.from_catalog),
        model: str(d.model) || null,
      });
    }
  }
  const models = obj(root.models);
  return {
    id: str(org.id),
    name: str(org.name),
    cosName: str(obj(root.cos).display_name) || DEFAULT_COS,
    frameworkVersion: str(root.framework_version) || null,
    chatLanguage: str(obj(root.language).chat),
    departments,
    models: {
      cos: str(models.cos) || null,
      departments: str(models.departments) || null,
      tiers: Array.isArray(models.tiers) ? models.tiers.map(str).filter(Boolean) : [],
    },
  };
}

/** The model a department's chat runs on: its own `model`, else models.departments, else null (Claude Code default). */
export function departmentModel(org: ParsedOrg, agent: string): string | null {
  const d = org.departments.find((x) => x.agent === agent);
  return d?.model ?? org.models.departments ?? null;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function stripTicks(s: string): string {
  return s.replace(/`/g, '').trim();
}

export function parseRoutingTable(claudeMd: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = claudeMd.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const header = splitRow(lines[i]).map((c) => stripTicks(c).toLowerCase());
    const a = header.indexOf('agent');
    const r = header.indexOf('role');
    if (a < 0 || r < 0) {
      // skip the rest of this table
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) i++;
      continue;
    }
    for (let j = i + 1; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
      const agent = stripTicks(cells[a] ?? '');
      const role = stripTicks(cells[r] ?? '');
      if (agent && role) result.set(agent, role);
    }
    return result;
  }
  return result;
}

export function roleFromId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function buildDepartments(org: ParsedOrg, roles: Map<string, string>): Department[] {
  return org.departments.map((d) => ({
    id: d.id,
    agent: d.agent,
    persona: d.displayName || d.agent,
    role: roles.get(d.agent) ?? roleFromId(d.id),
  }));
}

const ITEM_RE = /^-\s+([A-Z0-9]+-([AD])\d+)(?:\s+\[(high|normal|low)\])?(?:\s+\{(ok|do|decide|wait)\})?:\s*(.*)$/;
const ESCALATE_RE = /\s*\[escalate: holding\]/;
const SINCE_RE = /\s*\(since (\d{4}-\d{2}-\d{2})\)\s*$/;

function finishText(raw: string): { text: string; escalate: boolean; since: string | null } {
  let text = raw.trim();
  const escalate = ESCALATE_RE.test(text);
  if (escalate) text = text.replace(ESCALATE_RE, '');
  let since: string | null = null;
  const m = SINCE_RE.exec(text);
  if (m) {
    since = m[1];
    text = text.slice(0, m.index);
  }
  return { text: text.trim().replace(/\s+/g, ' '), escalate, since };
}

interface RawItem {
  entry: WaitingEntry;
  /** The text after the colon, finished later (since date, tags, status). */
  raw: string;
}

/**
 * The lines of a list section, from `start`, as entries in document order (plugin schemas state/1 and todo/1, "Parent and child
 * items"). A child is a line that starts with exactly two spaces and `- ` and has the item pattern; it gets `parent`, the code of the
 * nearest top-level item before it, when that is a parsed item. An orphan child and a wrongly indented line that has the item pattern
 * (more or fewer spaces, a tab, a grandchild) become top-level items, so nothing disappears. Any other indented line continues the
 * line before it. `match` reads one trimmed line as an item (null when it is not one).
 */
function scanItems(lines: string[], start: number, match: (line: string) => RawItem | null): RawItem[] {
  const out: RawItem[] = [];
  let parent: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.trim() || /^-\s+none\s*$/i.test(line.trim())) continue;
    const trimmed = line.trim();
    const indented = /^\s/.test(line);
    if (indented) {
      const child = /^ {2}-\s/.test(line);
      const item = /^-\s/.test(trimmed) ? match(trimmed) : null;
      if (item) {
        if (child && parent !== null && !('unparsed' in item.entry)) item.entry.parent = parent;
        out.push(item);
        continue;
      }
      if (out.length > 0) {
        const prev = out[out.length - 1];
        prev.raw += ' ' + trimmed;
        if ('unparsed' in prev.entry) prev.entry.unparsed += ' ' + trimmed;
        continue;
      }
    }
    const item = match(trimmed);
    const entry: RawItem = item ?? { entry: { unparsed: trimmed }, raw: trimmed };
    parent = 'unparsed' in entry.entry ? null : entry.entry.code;
    out.push(entry);
  }
  return out;
}

export function parseWaiting(stateMd: string): WaitingEntry[] {
  const lines = stateMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Waiting on the CEO\s*$/.test(l));
  if (start < 0) return [];
  const out = scanItems(lines, start, (line) => {
    const m = ITEM_RE.exec(line);
    if (!m) return null;
    return {
      entry: {
        code: m[1],
        kind: m[2] as 'A' | 'D',
        urgency: (m[3] as Urgency | undefined) ?? null,
        text: '',
        since: null,
        escalate: false,
        action: (m[4] as WaitingAction | undefined) ?? null,
      },
      raw: m[5],
    };
  });
  return out.map(({ entry, raw }) => {
    if ('unparsed' in entry) return entry;
    const f = finishText(raw);
    return { ...entry, text: f.text, escalate: f.escalate, since: f.since };
  });
}

const TODO_RE = /^-\s+([A-Z0-9]+-T\d+)(?:\s+\[(high|normal|low)\])?:\s*(.*)$/;
const STATUS_RE = /\.\s+Status:\s*(.*)$/;

/** The open items of `company/todo.md` (schema todo/1): the CEO's own tasks, T codes. Same rules as `parseWaiting`; the Done section is ignored. */
export function parseTodo(todoMd: string): WaitingEntry[] {
  const lines = todoMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Open\s*$/.test(l));
  if (start < 0) return [];
  const out = scanItems(lines, start, (line) => {
    const m = TODO_RE.exec(line);
    if (!m) return null;
    return {
      entry: { code: m[1], kind: 'T', urgency: (m[2] as Urgency | undefined) ?? null, text: '', status: null, since: null, escalate: false, action: 'do' },
      raw: m[3],
    };
  });
  return out.map(({ entry, raw }) => {
    if ('unparsed' in entry) return entry;
    let text = raw.trim();
    let since: string | null = null;
    const sm = SINCE_RE.exec(text);
    if (sm) {
      since = sm[1];
      text = text.slice(0, sm.index);
    }
    let status: string | null = null;
    const st = STATUS_RE.exec(text);
    if (st) {
      status = st[1].trim().replace(/\s+/g, ' ') || null;
      text = text.slice(0, st.index);
    }
    return { ...entry, text: text.trim().replace(/\s+/g, ' '), status, since };
  });
}

const STATES: InitiativeState[] = ['active', 'paused', 'done', 'dropped'];

function firstParagraph(lines: string[], heading: RegExp): string {
  const i = lines.findIndex((l) => heading.test(l));
  if (i < 0) return '';
  const para: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^#{1,6}\s/.test(l)) break;
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  return para.join(' ');
}

export function parseInitiativeStatus(slug: string, md: string): Initiative {
  const result: Initiative = { slug, title: '', state: 'unknown', updated: null, goal: '', stateText: '', nextStep: '' };
  try {
    const lines = md.split(/\r?\n/);
    let body = lines;
    if (lines[0]?.trim() === '---') {
      const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
      if (end > 0) {
        try {
          const fm = obj(parseYaml(lines.slice(1, end).join('\n')));
          const st = str(fm.state).toLowerCase() as InitiativeState;
          if (STATES.includes(st)) result.state = st;
          const up = fm.updated instanceof Date ? fm.updated.toISOString().slice(0, 10) : str(fm.updated);
          result.updated = up || null;
        } catch {
          // keep defaults
        }
        body = lines.slice(end + 1);
      }
    }
    const h1 = body.find((l) => /^#\s+\S/.test(l));
    if (h1) result.title = h1.replace(/^#\s+/, '').trim();
    result.goal = firstParagraph(body, /^##\s+Goal\s*$/);
    result.stateText = firstParagraph(body, /^##\s+State\s*$/);
    result.nextStep = firstParagraph(body, /^##\s+Next step\s*$/);
  } catch {
    // never throw
  }
  return result;
}
