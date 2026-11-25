// The org chart: a typed, non-throwing reading of org.yaml and the frontmatter of `.claude/agents/*.md`.
// Pure parsing in `parseOrgChart`; `readOrgChart` only reads the files. `parseOrgYaml` is reused for the departments,
// the chief of staff name and the models, and keeps its own contract (invalid YAML gives an empty org, silently).
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { t } from '../../shared/strings';
import type { HqChange } from './watch';
import { parseOrgYaml } from './parse';
import { parseAppLook, pickLookFile, type LookFile } from './app-look';
import type { OrgChart, OrgChartWorker } from '../../shared/types';

export interface AgentFile {
  /** File name, for example `max.md`. */
  file: string;
  text: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function emptyChart(error: string | null = null): OrgChart {
  return { ceo: { roleId: 'ceo', displayName: '' }, cos: { displayName: t('cos.role'), model: null }, departments: [], workers: { rule: null, types: [] }, tiers: [], problems: [], error, staleError: null, readAt: null };
}

/** The YAML between the first two `---` lines (CRLF, a BOM and extra keys are fine). `ok` is false when the header is not valid YAML. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; ok: boolean } {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: {}, ok: true };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { data: {}, ok: true };
  try {
    return { data: obj(parseYaml(lines.slice(1, end).join('\n'))), ok: true };
  } catch {
    return { data: {}, ok: false };
  }
}

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].trim();
}

/** The parser detail of a YAML error for the error plate: `Line 23: All mapping items must start at the same column`. */
export function yamlDetail(e: unknown): string {
  const line = (e as { linePos?: Array<{ line?: number }> })?.linePos?.[0]?.line;
  const text = reason(e).replace(/\s+at line \d+, column \d+:?$/, '').trim();
  return line ? t('orgChart.err.yaml', { line, reason: text }) : t('orgChart.err.yamlNoLine', { reason: text });
}

/** The first sentence of a description (the chip tooltip), whitespace collapsed. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(flat);
  return (m ? m[1] : flat).trim();
}

/** The worker names in `Agent(a, b)` on a `tools:` value (a comma string or a list). `null`: no Agent tool; `'any'`: a bare `Agent`. */
export function agentToolNames(tools: unknown): string[] | 'any' | null {
  const text = Array.isArray(tools) ? tools.map(str).join(', ') : str(tools);
  const names: string[] = [];
  let found = false;
  for (const m of text.matchAll(/(?:^|[\s,])Agent\s*(?:\(([^)]*)\))?(?=[\s,]|$)/g)) {
    found = true;
    if (m[1] === undefined) return 'any';
    for (const n of m[1].split(',')) if (n.trim() && !names.includes(n.trim())) names.push(n.trim());
  }
  return found ? names : null;
}

/** The model a worker runs on when its file names none: one tier below the parent (`one-down`, never below the last tier) or the same (`same`). */
export function derivedWorkerModel(rule: string | null, tiers: string[], parent: string | null): string | null {
  if (!parent) return null;
  if (rule === 'same') return parent;
  if (rule === 'one-down') {
    const i = tiers.indexOf(parent);
    return i < 0 ? null : tiers[Math.min(i + 1, tiers.length - 1)];
  }
  return null;
}

interface AgentInfo {
  file: string;
  name: string | null;
  model: string | null;
  description: string;
  tools: string[] | 'any' | null;
}

/**
 * `lookFiles` are the `departments/<id>/app-look.yaml` files that exist; `warn` gets one list of reasons when the look
 * file (or part of it) is not used. `readAt` is set by `readOrgChart`; this function is pure.
 */
export function parseOrgChart(orgYamlText: string, agentFiles: AgentFile[], lookFiles: LookFile[] = [], warn?: (reasons: string[]) => void): OrgChart {
  if (!orgYamlText.trim()) return emptyChart(t('orgChart.err.empty'));
  let doc: unknown;
  try {
    doc = parseYaml(orgYamlText);
  } catch (e) {
    return emptyChart(yamlDetail(e));
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return emptyChart(t('orgChart.err.shape'));
  const root = obj(doc);
  const org = parseOrgYaml(orgYamlText);
  const problems: string[] = [];
  const rule = str(obj(root.models).workers) || null;

  const agents = new Map<string, AgentInfo>();
  for (const f of [...agentFiles].sort((a, b) => a.file.localeCompare(b.file))) {
    const stem = f.file.replace(/\.md$/i, '');
    const fm = parseFrontmatter(f.text);
    if (!fm.ok) problems.push(t('orgChart.problem.agentYaml', { file: f.file }));
    const model = str(fm.data.model);
    agents.set(stem, {
      file: f.file,
      name: str(fm.data.name) || null,
      model: model && model !== 'inherit' ? model : null,
      description: firstSentence(str(fm.data.description)),
      tools: agentToolNames(fm.data.tools),
    });
  }

  const departmentAgents = new Set(org.departments.map((d) => d.agent));
  /** A worker type by name (the file name or the frontmatter `name`); a name with no file still gets a chip. */
  const worker = (name: string, parentModel: string | null): OrgChartWorker => {
    const a = agents.get(name) ?? [...agents.values()].find((x) => x.name === name);
    return { name: a?.name ?? name, model: a?.model ?? derivedWorkerModel(rule, org.models.tiers, parentModel), description: a?.description ?? '' };
  };
  const helpers = [...agents.entries()].filter(([stem]) => !departmentAgents.has(stem)).map(([stem]) => stem);

  const ids = org.departments.map((d) => d.id);
  const lookResult = parseAppLook(pickLookFile(ids, lookFiles), ids);
  if (lookResult.warnings.length) warn?.(lookResult.warnings);

  const departments = org.departments.map((d) => {
    const a = agents.get(d.agent);
    if (!d.displayName) problems.push(t('orgChart.problem.noDisplayName', { id: d.id }));
    if (!a) problems.push(t('orgChart.problem.noAgentFile', { id: d.id, agent: d.agent }));
    else if (!a.name) problems.push(t('orgChart.problem.agentNoName', { file: a.file }));
    else if (a.name !== d.agent) problems.push(t('orgChart.problem.agentName', { file: a.file, name: a.name, id: d.id, agent: d.agent }));
    const model = d.model ?? org.models.departments;
    const names = a?.tools === 'any' ? helpers : a?.tools ?? [];
    return {
      id: d.id,
      agent: d.agent,
      displayName: d.displayName || d.id,
      catalogRole: d.fromCatalog,
      model,
      agentFile: { found: !!a, name: a?.name ?? null, model: a?.model ?? null },
      agentPath: `.claude/agents/${a?.file ?? `${d.agent}.md`}`,
      workers: names.map((n) => worker(n, model)),
      look: lookResult.look.get(d.id) ?? null,
    };
  });

  const types = helpers.map((stem) => worker(stem, org.models.cos)).sort((a, b) => a.name.localeCompare(b.name));

  const ceo = obj(root.ceo);
  return {
    ceo: { roleId: str(ceo.role_id) || 'ceo', displayName: str(ceo.display_name) },
    cos: { displayName: org.cosName, model: org.models.cos },
    departments,
    workers: { rule, types },
    tiers: org.models.tiers,
    problems,
    error: null,
    staleError: null,
    readAt: null,
  };
}

/** A file over this size is not read for the chart (org.yaml: an error; an agent file: a problem; app-look.yaml: initials). */
export const MAX_FILE_BYTES = 256 * 1024;

/** The text of a file, or `null` when it is over `MAX_FILE_BYTES` (never reads more than the cap plus one byte). Throws like `readFileSync` otherwise. */
export function readCapped(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > MAX_FILE_BYTES) return null;
    }
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** A folder name from org.yaml that is safe to join to a path. */
const safeSegment = (s: string): boolean => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..';

/** Reads org.yaml, `.claude/agents/*.md` and `departments/<id>/app-look.yaml` of an hq. Never throws: a failure is `error` on an empty chart. */
export function readOrgChart(hqPath: string, now: Date = new Date()): OrgChart {
  let text: string;
  try {
    const read = readCapped(path.join(hqPath, 'org.yaml'));
    if (read === null) return emptyChart(t('orgChart.err.tooBig'));
    text = read;
  } catch (e) {
    return emptyChart((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? t('orgChart.err.missing') : t('orgChart.err.unreadable', { reason: reason(e) }));
  }
  const files: AgentFile[] = [];
  const unreadable: string[] = [];
  const tooBig: string[] = [];
  try {
    const dir = path.join(hqPath, '.claude', 'agents');
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
      try {
        const body = readCapped(path.join(dir, ent.name));
        if (body === null) tooBig.push(ent.name);
        else files.push({ file: ent.name, text: body });
      } catch {
        unreadable.push(ent.name);
      }
    }
  } catch {
    // no agents folder: every department then reports a missing agent file
  }
  const looks: LookFile[] = [];
  for (const d of parseOrgYaml(text).departments) {
    if (!safeSegment(d.id) || looks.some((l) => l.department === d.id)) continue;
    try {
      const body = readCapped(path.join(hqPath, 'departments', d.id, 'app-look.yaml'));
      if (body === null) console.warn(`departments/${d.id}/app-look.yaml is over ${MAX_FILE_BYTES / 1024} KB: not used`);
      else looks.push({ department: d.id, text: body });
    } catch {
      // no look file for this department
    }
  }
  const chart = parseOrgChart(text, files, looks, (reasons) => console.warn(`app-look.yaml not fully used: ${reasons.join('; ')}`));
  if (chart.error) return chart;
  for (const f of unreadable) chart.problems.push(t('orgChart.problem.agentUnreadable', { file: f }));
  for (const f of tooBig) chart.problems.push(t('orgChart.problem.agentTooBig', { file: f, kb: MAX_FILE_BYTES / 1024 }));
  chart.readAt = now.toISOString();
  return chart;
}

/** True for the hq changes that can change the chart. */
export const affectsChart = (what: HqChange): boolean => what === 'org' || what === 'agents' || what === 'look';

/** Everything of a chart except when it was read: two reads of the same files are the same chart. */
const signature = (c: OrgChart): string => JSON.stringify({ ...c, readAt: null });

/**
 * Reads the chart and tells when it differs from the last one read, so a CLAUDE.md edit does not emit. It keeps the
 * last good chart: when org.yaml becomes unreadable after a good read, the chart comes back as that last good one
 * with `staleError` set, so a half-saved edit never empties the screen.
 */
export class ChartTracker {
  private last = '';
  private good: OrgChart | null = null;
  constructor(private readonly hqPath: string) {}

  private next(now: Date): OrgChart {
    const c = readOrgChart(this.hqPath, now);
    if (!c.error) {
      this.good = c;
      return c;
    }
    return this.good ? { ...this.good, staleError: c.error } : c;
  }

  read(now: Date = new Date()): OrgChart {
    const c = this.next(now);
    this.last = signature(c);
    return c;
  }

  /** The new chart if it changed since the last read, else null. */
  changed(now: Date = new Date()): OrgChart | null {
    const c = this.next(now);
    const sig = signature(c);
    if (sig === this.last) return null;
    this.last = sig;
    return c;
  }
}
