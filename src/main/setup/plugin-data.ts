// What the plugin offers the setup wizard screens, read from its own files (catalog, gates), never copied into the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEV, PLUGIN_ID } from '../config';
import { run, type Runner } from '../system/exec';
import type { PluginEntry } from '../system/plugin';
import { compareVersions, parseVersion } from '../system/version';
import type { CatalogEntry, GateAction, GateTier, SetupData } from '../../shared/setup';

const CATALOG_ORDER = ['engineering', 'design-brand', 'business', 'growth-social', 'legal', 'finance', 'tax', 'operations', 'health', 'money', 'paperwork'];
const ADVISORY = new Set(['legal', 'finance', 'tax', 'health', 'money', 'paperwork']);
const PERSONAL_ONLY = new Set(['health', 'money', 'paperwork']);
const LOCKED = new Set(['file-or-sign', 'make-payment']);
const TIERS: GateTier[] = ['free', 'notice', 'ok'];

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The plugin version in its manifest, or null. */
export function pluginVersionAt(dir: string): string | null {
  const raw = readText(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The plugin folder to load with `--plugin-dir`: the development folder when set, else the highest installed version
 * (`claude plugin list --json`, entries whose `installPath` exists). Null when the plugin is not installed on this computer.
 */
export async function findPluginDir(claudePath: string, runner: Runner = run): Promise<{ dir: string; version: string } | null> {
  if (DEV.pluginDir) return { dir: DEV.pluginDir, version: pluginVersionAt(DEV.pluginDir) ?? '' };
  const r = await runner(claudePath, ['plugin', 'list', '--json'], { cwd: os.tmpdir(), timeoutMs: 30000 });
  if (r.error || r.code !== 0) return null;
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  let best: { dir: string; version: string } | null = null;
  for (const e of list as PluginEntry[]) {
    if (!e || e.id !== PLUGIN_ID || typeof e.installPath !== 'string' || !e.installPath) continue;
    try {
      if (!fs.statSync(e.installPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const version = parseVersion(typeof e.version === 'string' ? e.version : null) ?? pluginVersionAt(e.installPath) ?? '0.0.0';
    if (!best || compareVersions(version, best.version) > 0) best = { dir: e.installPath, version };
  }
  return best;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** The lines of the `## <heading>` section, up to the next `## ` heading. */
function section(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

function tableRows(lines: string[]): string[][] {
  return lines.filter((l) => l.trim().startsWith('|')).map(cells).filter((r) => !r.every((c) => /^:?-{3,}:?$/.test(c)));
}

/** The gate actions of gates/default.md in tier order: the table "The table" joined with "Actions in plain language". */
export function parseGates(text: string): GateAction[] {
  const meaning = new Map<string, { meaning: string; example: string }>();
  for (const row of tableRows(section(text, 'Actions in plain language')).slice(1)) {
    const id = /`([a-z0-9-]+)`/.exec(row[0] ?? '')?.[1];
    if (id) meaning.set(id, { meaning: row[1] ?? '', example: row[2] ?? '' });
  }
  const out: GateAction[] = [];
  for (const row of tableRows(section(text, 'The table')).slice(1)) {
    const tier = (row[0] ?? '').toLowerCase() as GateTier;
    if (!TIERS.includes(tier)) continue;
    for (const m of (row[2] ?? '').matchAll(/`([a-z0-9-]+)`/g)) {
      const id = m[1];
      out.push({ id, tier, meaning: meaning.get(id)?.meaning ?? '', example: meaning.get(id)?.example ?? '', locked: LOCKED.has(id) });
    }
  }
  return out;
}

function firstLineAfter(text: string, heading: string): string {
  return section(text, heading).map((l) => l.trim()).find(Boolean) ?? '';
}

function readCatalog(pluginDir: string): CatalogEntry[] {
  const root = path.join(pluginDir, 'catalog');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const entries: CatalogEntry[] = [];
  for (const id of names) {
    const charter = readText(path.join(root, id, 'charter.md'));
    const agent = readText(path.join(root, id, 'agent.md'));
    if (charter === null || agent === null) continue;
    const role = /\bthe (.+?) department of\b/i.exec(agent)?.[1]?.trim() || id;
    entries.push({ id, role, purpose: firstLineAfter(charter, 'Purpose'), advisory: ADVISORY.has(id), personalOnly: PERSONAL_ONLY.has(id) });
  }
  const rank = (id: string) => {
    const i = CATALOG_ORDER.indexOf(id);
    return i < 0 ? CATALOG_ORDER.length : i;
  };
  return entries.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * What the wizard screens show, read from the plugin folder. Missing files give empty parts; it throws only when there is
 * nothing usable (no catalog and no gates).
 */
export function readSetupData(pluginDir: string): SetupData {
  const catalog = readCatalog(pluginDir);
  const gatesText = readText(path.join(pluginDir, 'gates', 'default.md'));
  const gates = gatesText ? parseGates(gatesText) : [];
  if (catalog.length === 0 && gates.length === 0) throw new Error(`No catalog or gates found in the plugin folder ${pluginDir}`);
  return { pluginVersion: pluginVersionAt(pluginDir) ?? '', catalog, gates, tiers: ['opus', 'sonnet', 'haiku'] };
}
