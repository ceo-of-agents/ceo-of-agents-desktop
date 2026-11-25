import type { HealthStatus } from '../../shared/types';
import { t, tn } from '../../shared/strings';
import { run, type Runner } from '../system/exec';
import * as g from './git';

export interface HealthInput {
  isRepo: boolean;
  hasRemote: boolean;
  fetchOk: boolean | null;
  ahead: number;
  behind: number;
  conflict: boolean;
  plugin: 'ok' | 'missing' | 'old' | 'unknown';
  pluginMinimum: string;
  autoPushFailing: boolean;
  /** Short last push error, while auto push is failing. */
  pushError?: string | null;
  lastSyncAt: string | null;
  syncing: boolean;
}

export function computeHealth(i: HealthInput): HealthStatus {
  const h = computeColor(i);
  // While a sync runs the sentence says so (a problem keeps its own sentence).
  return i.syncing && h.color !== 'red' ? { ...h, sentence: t('health.syncing.sentence') } : h;
}

function computeColor(i: HealthInput): HealthStatus {
  const base = {
    hasRemote: i.hasRemote,
    ahead: i.ahead,
    behind: i.behind,
    lastSyncAt: i.lastSyncAt,
    autoPushFailing: i.autoPushFailing,
    syncing: i.syncing,
    pushError: i.autoPushFailing ? (i.pushError ?? null) : null,
  };
  const make = (color: HealthStatus['color'], sentence: string, extra: Partial<HealthStatus> = {}): HealthStatus => ({ color, sentence, ...base, ...extra });

  if (!i.isRepo) return make('red', t('health.red.notRepo'));
  if (i.plugin === 'missing') return make('red', t('health.red.pluginMissing'));
  if (i.plugin === 'old') return make('red', t('health.red.pluginOld', { minimum: i.pluginMinimum }));
  // Both need hands: a retry cannot fix them. A real conflict (same files) is told apart from a plain divergence.
  if (i.conflict) return make('red', t('health.red.conflict'), { conflict: 'files' });
  if (i.ahead > 0 && i.behind > 0) return make('red', t('health.red.diverged'), { conflict: 'diverged' });
  if (i.fetchOk === false) return make('red', t('health.red.unreachable'));
  if (!i.hasRemote) return make('orange', t('health.orange'));
  if (i.autoPushFailing) {
    return make('yellow', t('health.yellow.pushFailing', { reason: i.pushError || t('health.pushError.unknown') }));
  }
  if (i.ahead > 0) return make('yellow', tn('health.yellow.ahead', i.ahead));
  if (i.behind > 0) return make('yellow', tn('health.yellow.behind', i.behind));
  return make('green', t('health.green'));
}

export interface CheckOptions {
  plugin: HealthInput['plugin'];
  pluginMinimum: string;
  autoPushFailing: boolean;
  pushError?: string | null;
  lastSyncAt: string | null;
  fetch: boolean;
  syncing?: boolean;
  runner?: Runner;
}

export async function checkHealth(hqPath: string, opts: CheckOptions): Promise<HealthStatus> {
  const runner = opts.runner ?? run;
  const repo = await g.isRepo(hqPath, runner);
  let hasRemote = false;
  let fetchOk: boolean | null = null;
  let ab: { ahead: number; behind: number } | null = null;
  let conflict = false;
  if (repo) {
    hasRemote = (await g.remotes(hqPath, runner)).length > 0;
    if (hasRemote && opts.fetch) fetchOk = (await g.fetch(hqPath, runner)).ok;
    if (hasRemote) ab = await g.aheadBehind(hqPath, runner);
    conflict = await g.hasConflict(hqPath, runner);
  }
  return computeHealth({
    isRepo: repo,
    hasRemote,
    fetchOk,
    ahead: ab?.ahead ?? 0,
    behind: ab?.behind ?? 0,
    conflict,
    plugin: opts.plugin,
    pluginMinimum: opts.pluginMinimum,
    autoPushFailing: opts.autoPushFailing,
    pushError: opts.pushError ?? null,
    lastSyncAt: opts.lastSyncAt,
    syncing: opts.syncing ?? false,
  });
}

/** On opening an org: fetch and fast-forward. Never throws. */
export async function pullOnOpen(hqPath: string, runner: Runner = run): Promise<g.GitResult> {
  try {
    if ((await g.remotes(hqPath, runner)).length === 0) return { ok: true, error: null };
    if (!(await g.upstream(hqPath, runner))) return { ok: true, error: null };
    const f = await g.fetch(hqPath, runner);
    if (!f.ok) return f;
    return await g.pullFfOnly(hqPath, runner);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sync(
  hqPath: string,
  runner: Runner = run,
): Promise<g.GitResult & { step: 'pull' | 'push' | null }> {
  try {
    if ((await g.remotes(hqPath, runner)).length === 0) return { ok: false, error: 'no remote', step: null };
    if (await g.upstream(hqPath, runner)) {
      const p = await g.pullFfOnly(hqPath, runner);
      if (!p.ok) return { ...p, step: 'pull' };
    } else {
      await g.fetch(hqPath, runner);
    }
    const s = await g.push(hqPath, runner);
    if (!s.ok) return { ...s, step: 'push' };
    return { ok: true, error: null, step: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), step: null };
  }
}
