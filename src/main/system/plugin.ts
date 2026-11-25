import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PluginStatus } from '../../shared/types';
import { MIN_PLUGIN_VERSION, PLUGIN_ID, PLUGIN_LATEST_RELEASE_URL, PLUGIN_MARKETPLACE_NAME, PLUGIN_MARKETPLACE_SOURCE } from '../config';
import { run, type Runner } from './exec';
import { compareVersions, parseVersion } from './version';
import { t } from '../../shared/strings';

export interface PluginActionResult {
  ok: boolean;
  error: string | null;
}

export interface PluginStatusOptions {
  runner?: Runner;
  fetchLatest?: () => Promise<string | null>;
}

export interface PluginEntry {
  id?: unknown;
  version?: unknown;
  installPath?: unknown;
  scope?: unknown;
  enabled?: unknown;
  projectPath?: unknown;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function hqFrameworkVersion(hqPath: string): string | null {
  try {
    const doc = parseYaml(fs.readFileSync(path.join(hqPath, 'org.yaml'), 'utf8')) as { framework_version?: unknown } | null;
    const v = doc?.framework_version;
    return v === undefined || v === null ? null : parseVersion(String(v));
  } catch {
    return null;
  }
}

function enabledInSettings(hqPath: string): boolean {
  const s = readJson(path.join(hqPath, '.claude', 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | null;
  return s?.enabledPlugins?.[PLUGIN_ID] === true;
}

export async function pluginStatus(claudePath: string, hqPath: string, opts: PluginStatusOptions = {}): Promise<PluginStatus> {
  const runner = opts.runner ?? run;
  const latest = opts.fetchLatest ? await opts.fetchLatest().catch(() => null) : null;
  const hqVersion = hqFrameworkVersion(hqPath);
  const base: PluginStatus = {
    state: 'unknown',
    installed: null,
    latest,
    updateAvailable: false,
    hqFrameworkVersion: hqVersion,
    orgUpdateAvailable: false,
    belowMinimum: false,
    minimum: MIN_PLUGIN_VERSION,
    latestCheckFailed: !!opts.fetchLatest && latest === null,
    dev: false,
  };
  const r = await runner(claudePath, ['plugin', 'list', '--json'], { cwd: hqPath, timeoutMs: 30000 });
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    list = null;
  }
  if (r.error || r.code !== 0 || !Array.isArray(list)) return base;

  const hqReal = real(hqPath);
  const entry = (list as PluginEntry[]).find(
    (e) =>
      e && e.id === PLUGIN_ID && e.enabled === true &&
      (e.scope === 'user' || (typeof e.projectPath === 'string' && real(e.projectPath) === hqReal)),
  );
  if (!entry) {
    return { ...base, state: enabledInSettings(hqPath) ? 'enabled-not-installed' : 'missing' };
  }
  const installed = parseVersion(typeof entry.version === 'string' ? entry.version : null);
  return {
    ...base,
    state: 'ok',
    installed,
    updateAvailable: !!(installed && latest && compareVersions(installed, latest) < 0),
    orgUpdateAvailable: !!(installed && hqVersion && compareVersions(hqVersion, installed) < 0),
    belowMinimum: installed ? compareVersions(installed, MIN_PLUGIN_VERSION) < 0 : false,
  };
}

/** With COA_PLUGIN_DIR set (development), the plugin comes from that folder: report it as installed. */
export function devPluginStatus(p: PluginStatus, pluginDir: string): PluginStatus {
  let installed = p.installed;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    installed = typeof manifest.version === 'string' ? manifest.version : installed;
  } catch {
    // keep what the CLI said
  }
  // The plugin comes from a folder, so the app cannot update it: no Update button. The org check still applies.
  const hq = p.hqFrameworkVersion;
  return {
    ...p,
    state: 'ok',
    installed,
    updateAvailable: false,
    orgUpdateAvailable: !!(hq && installed && compareVersions(hq, installed) < 0),
    belowMinimum: !!(installed && compareVersions(installed, MIN_PLUGIN_VERSION) < 0),
    dev: true,
  };
}

// ---------- latest release ----------

let cache: { at: number; value: string } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export function clearLatestCache(): void {
  cache = null;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await fetchImpl(PLUGIN_LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ceo-of-agents-app' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== 'string' || !body.tag_name) return null;
    const value = body.tag_name.replace(/^v/, '');
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

// ---------- install / update ----------

const LONG = 120000;

function lastLines(s: string, n = 4): string {
  return s.trim().split('\n').filter(Boolean).slice(-n).join('\n');
}

function failure(message: string, stderr: string, stdout = ''): PluginActionResult {
  const tail = lastLines(stderr) || lastLines(stdout);
  return { ok: false, error: tail ? `${message}\n${tail}` : message };
}

const CONFIRM_RE = /confirm|-y\b|--yes|accept|TTY|marketplace-declared/i;

export async function installPlugin(claudePath: string, hqPath: string, runner: Runner = run): Promise<PluginActionResult> {
  const list = await runner(claudePath, ['plugin', 'marketplace', 'list', '--json'], { cwd: hqPath, timeoutMs: 30000 });
  let has = false;
  try {
    const arr: unknown = JSON.parse(list.stdout);
    has = Array.isArray(arr) && arr.some((m) => (m as { name?: unknown })?.name === PLUGIN_MARKETPLACE_NAME);
  } catch {
    has = false;
  }
  if (!has) {
    const add = await runner(claudePath, ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE_SOURCE], { cwd: hqPath, timeoutMs: LONG });
    if (add.code !== 0 || add.error) return failure(t('plugin.err.addSource'), add.stderr, add.stdout);
  }
  const inst = await runner(claudePath, ['plugin', 'install', PLUGIN_ID, '--scope', 'project'], { cwd: hqPath, timeoutMs: LONG });
  if (inst.code !== 0 || inst.error) {
    if (CONFIRM_RE.test(inst.stderr + inst.stdout)) {
      return failure(t('plugin.err.installConfirm'), inst.stderr, inst.stdout);
    }
    return failure(t('plugin.err.install'), inst.stderr, inst.stdout);
  }
  return { ok: true, error: null };
}

export async function updatePlugin(claudePath: string, hqPath: string, runner: Runner = run): Promise<PluginActionResult> {
  const mk = await runner(claudePath, ['plugin', 'marketplace', 'update', PLUGIN_MARKETPLACE_NAME], { cwd: hqPath, timeoutMs: LONG });
  if (mk.code !== 0 || mk.error) return failure(t('plugin.err.refreshSource'), mk.stderr, mk.stdout);
  const up = await runner(claudePath, ['plugin', 'update', PLUGIN_ID, '--scope', 'project'], { cwd: hqPath, timeoutMs: LONG });
  if (up.code !== 0 || up.error) {
    if (CONFIRM_RE.test(up.stderr + up.stdout)) {
      return failure(t('plugin.err.updateConfirm'), up.stderr, up.stdout);
    }
    return failure(t('plugin.err.update'), up.stderr, up.stdout);
  }
  return { ok: true, error: null };
}
