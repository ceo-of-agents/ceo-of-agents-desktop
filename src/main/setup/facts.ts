// The real milestones of a setup run, detected from the new org's folder only (never guessed from the conversation).
import fs from 'node:fs';
import path from 'node:path';
import { parseOrgYaml } from '../hq/parse';
import { run, type Runner } from '../system/exec';
import { EMPTY_FACTS, type SetupFacts } from '../../shared/setup';

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function pluginEnabledIn(settingsText: string | null): boolean {
  if (!settingsText) return false;
  try {
    const enabled = (JSON.parse(settingsText) as { enabledPlugins?: unknown }).enabledPlugins;
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return false;
    return Object.entries(enabled as Record<string, unknown>).some(([k, v]) => k.startsWith('ceo-of-agents@') && v === true);
  } catch {
    return false;
  }
}

/** Short sha of HEAD, or null (not a git repo of its own, no commit, git missing, timeout). Never throws. */
export async function headCommit(folder: string, runner: Runner = run): Promise<string | null> {
  // A folder inside another repo has no `.git` of its own: its HEAD is not the new org's.
  if (!fs.existsSync(path.join(folder, '.git'))) return null;
  try {
    const r = await runner('git', ['rev-parse', '--short', 'HEAD'], { cwd: folder, timeoutMs: 5000 });
    if (r.error || r.code !== 0) return null;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{4,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function detectFacts(folder: string, runner?: Runner): Promise<SetupFacts> {
  try {
    const orgText = readText(path.join(folder, 'org.yaml'));
    const org = orgText ? parseOrgYaml(orgText) : null;
    let decisionRecord = false;
    try {
      decisionRecord = fs.readdirSync(path.join(folder, 'decisions')).some((n) => /^0001-.*\.md$/.test(n));
    } catch {
      // no decisions folder yet
    }
    const settingsFile = path.join(folder, '.claude', 'settings.json');
    return {
      orgYaml: orgText !== null,
      decisionRecord,
      state: isFile(path.join(folder, 'company', 'state.md')),
      settings: isFile(settingsFile),
      pluginEnabled: pluginEnabledIn(readText(settingsFile)),
      commit: await headCommit(folder, runner),
      orgName: org && org.name ? org.name : null,
      cosName: org && org.name ? org.cosName : null,
    };
  } catch {
    return { ...EMPTY_FACTS };
  }
}
