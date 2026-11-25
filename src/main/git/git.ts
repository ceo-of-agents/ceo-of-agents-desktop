// Small helpers over `git -C <hq> ...`. The runner is injectable for tests.
import fs from 'node:fs';
import path from 'node:path';
import { run, type Runner } from '../system/exec';

export interface GitResult {
  ok: boolean;
  error: string | null;
  /** Full stderr (or stdout) of a failed command, for classifying the failure. */
  detail?: string;
}

async function git(hq: string, args: string[], runner: Runner, timeoutMs = 30000) {
  return runner('git', ['-C', hq, ...args], { timeoutMs });
}

function lastLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function toResult(r: { code: number | null; stderr: string; stdout: string; error: string | null }): GitResult {
  if (r.code === 0 && !r.error) return { ok: true, error: null };
  return {
    ok: false,
    error: lastLine(r.stderr) || lastLine(r.stdout) || r.error || 'git failed',
    detail: r.stderr || r.stdout || r.error || '',
  };
}

export async function isRepo(hq: string, runner: Runner = run): Promise<boolean> {
  if (!fs.existsSync(hq)) return false;
  const r = await git(hq, ['rev-parse', '--is-inside-work-tree'], runner);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function currentBranch(hq: string, runner: Runner = run): Promise<string | null> {
  const r = await git(hq, ['rev-parse', '--abbrev-ref', 'HEAD'], runner);
  const b = r.stdout.trim();
  return r.code === 0 && b && b !== 'HEAD' ? b : null;
}

export async function remotes(hq: string, runner: Runner = run): Promise<string[]> {
  const r = await git(hq, ['remote'], runner);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function upstream(hq: string, runner: Runner = run): Promise<string | null> {
  const r = await git(hq, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], runner);
  const u = r.stdout.trim();
  return r.code === 0 && u ? u : null;
}

export async function fetch(hq: string, runner: Runner = run): Promise<GitResult> {
  return toResult(await git(hq, ['fetch', '--quiet'], runner, 20000));
}

export async function aheadBehind(
  hq: string,
  runner: Runner = run,
): Promise<{ ahead: number; behind: number } | null> {
  let target = await upstream(hq, runner);
  if (!target) {
    const branch = await currentBranch(hq, runner);
    if (!branch || !(await remotes(hq, runner)).includes('origin')) return null;
    const ref = `refs/remotes/origin/${branch}`;
    const v = await git(hq, ['rev-parse', '--verify', '--quiet', ref], runner);
    if (v.code !== 0) return null;
    target = `origin/${branch}`;
  }
  const r = await git(hq, ['rev-list', '--left-right', '--count', `HEAD...${target}`], runner);
  if (r.code !== 0) return null;
  const [a, b] = r.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return { ahead: a, behind: b };
}

async function gitPath(hq: string, name: string, runner: Runner): Promise<string | null> {
  const r = await git(hq, ['rev-parse', '--git-path', name], runner);
  if (r.code !== 0) return null;
  const p = r.stdout.trim();
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(hq, p);
}

/** True when a rebase or merge is in progress (someone is working in the repo). */
export async function operationInProgress(hq: string, runner: Runner = run): Promise<boolean> {
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const p = await gitPath(hq, name, runner);
    if (p && fs.existsSync(p)) return true;
  }
  return false;
}

export async function hasConflict(hq: string, runner: Runner = run): Promise<boolean> {
  const d = await git(hq, ['diff', '--name-only', '--diff-filter=U'], runner);
  if (d.code === 0 && d.stdout.trim()) return true;
  return operationInProgress(hq, runner);
}

export async function pullFfOnly(hq: string, runner: Runner = run): Promise<GitResult> {
  return toResult(await git(hq, ['pull', '--ff-only', '--quiet'], runner, 60000));
}

export async function push(hq: string, runner: Runner = run): Promise<GitResult> {
  if (await upstream(hq, runner)) return toResult(await git(hq, ['push', '--quiet'], runner, 60000));
  const [first] = await remotes(hq, runner);
  if (!first) return { ok: false, error: 'no remote' };
  return toResult(await git(hq, ['push', '--quiet', '-u', first, 'HEAD'], runner, 60000));
}

/** True when the upstream branch already contains HEAD (nothing to push). False without an upstream. */
export async function upstreamContainsHead(hq: string, runner: Runner = run): Promise<boolean> {
  if (!(await upstream(hq, runner))) return false;
  const r = await git(hq, ['merge-base', '--is-ancestor', 'HEAD', '@{u}'], runner);
  return r.code === 0;
}

/** True when tracked files have changes not committed yet (a rebase would refuse to run). */
export async function hasTrackedChanges(hq: string, runner: Runner = run): Promise<boolean> {
  const r = await git(hq, ['status', '--porcelain', '--untracked-files=no'], runner);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Pull with rebase. No --quiet and no --autostash: conflict text must reach us, and a stash pop conflict would leave markers in the tree. */
export async function pullRebase(hq: string, runner: Runner = run): Promise<GitResult> {
  const r = await git(hq, ['pull', '--rebase'], runner, 60000);
  const res = toResult(r);
  if (!res.ok) res.detail = `${r.stderr}\n${r.stdout}\n${r.error ?? ''}`;
  return res;
}

export async function rebaseAbort(hq: string, runner: Runner = run): Promise<void> {
  await git(hq, ['rebase', '--abort'], runner);
}

export async function headSha(hq: string, runner: Runner = run): Promise<string | null> {
  const r = await git(hq, ['rev-parse', 'HEAD'], runner);
  return r.code === 0 ? r.stdout.trim() : null;
}

export { gitPath };
