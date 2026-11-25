// Live checks, skipped unless COA_LIVE=1. Everything runs with an empty CLAUDE_CONFIG_DIR; no login is completed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, run, spawnProcess, type Runner } from '../../src/main/system/exec';
import { locateClaude } from '../../src/main/system/locate';
import { installPlugin, pluginStatus, updatePlugin } from '../../src/main/system/plugin';
import { SignInFlow } from '../../src/main/system/signin';

const live = process.env.COA_LIVE === '1';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe.skipIf(!live)('live', () => {
  it('install, status, update in isolation', async () => {
    const claude = await locateClaude();
    expect(claude).toBeTruthy();
    const cfg = tmp('coa-cfg-');
    const hq = tmp('coa-hq-');
    fs.writeFileSync(path.join(hq, 'org.yaml'), 'framework_version: 0.1.0\n');
    fs.writeFileSync(path.join(hq, 'CLAUDE.md'), '# test\n');
    const env = childEnv({ CLAUDE_CONFIG_DIR: cfg });
    const runner: Runner = (c, a, o) => run(c, a, { ...o, env });
    const inst = await installPlugin(claude!, hq, runner);
    console.warn('INSTALL', JSON.stringify(inst));
    expect(inst.ok).toBe(true);
    const st = await pluginStatus(claude!, hq, { runner });
    console.warn('STATUS', JSON.stringify(st));
    expect(st.state).toBe('ok');
    expect(st.installed).toMatch(/\d+\.\d+\.\d+/);
    const up = await updatePlugin(claude!, hq, runner);
    console.warn('UPDATE', JSON.stringify(up));
  }, 400000);

  it('sign-in captures the URL then cancels', async () => {
    const claude = await locateClaude();
    const cfg = tmp('coa-cfg-');
    const env = childEnv({ CLAUDE_CONFIG_DIR: cfg, BROWSER: '/usr/bin/true' });
    const flow = new SignInFlow({ spawner: spawnProcess, runner: (c, a, o) => run(c, a, { ...o, env }), env });
    flow.start(claude!);
    const url = await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 30000);
      flow.on('state', (s) => {
        if (s.url) {
          clearTimeout(t);
          resolve(s.url);
        }
      });
    });
    console.warn('SIGNIN URL', url ? url.slice(0, 60) + '...' : null);
    flow.cancel();
    expect(url).toMatch(/^https:\/\//);
    expect(flow.getState().running).toBe(false);
  }, 60000);
});
