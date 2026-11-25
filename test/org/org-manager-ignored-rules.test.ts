import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/types';

vi.mock('../../src/main/system/prereqs', () => ({ checkPrereqs: vi.fn() }));

import { OrgManager } from '../../src/main/org/org-manager';

let root: string;
let hqDir: string;
let events: AppEvent[];
let manager: OrgManager;
let orgId: string;
const local = () => path.join(hqDir, '.claude', 'settings.local.json');
const healthEvents = () => events.filter((e): e is Extract<AppEvent, { type: 'health' }> => e.type === 'health');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-ign-')));
  hqDir = path.join(root, 'hq');
  fs.mkdirSync(path.join(hqDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(hqDir, 'org.yaml'), 'org:\n  id: T\n');
  fs.writeFileSync(path.join(hqDir, 'CLAUDE.md'), '# T\n');
  events = [];
  manager = new OrgManager({ dataDir: path.join(root, 'data'), settings: {} as never, broker: {} as never, serverScript: 's', nodePath: 'node', emit: (e) => events.push(e) });
  orgId = manager.registry.add(hqDir).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('health: ignored rules', () => {
  it('splits them by file and never changes the indicator colour', async () => {
    fs.writeFileSync(path.join(hqDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(python *)'] } }));
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(rm *)', 'Bash(make test)'] } }));
    const withRules = await manager.refreshHealth(orgId, false);
    expect(withRules?.droppedRules).toEqual({ local: ['Bash(rm *)'], project: ['Bash(python *)'] });
    fs.rmSync(path.join(hqDir, '.claude', 'settings.json'));
    fs.rmSync(local());
    const without = await manager.refreshHealth(orgId, false);
    expect(without?.droppedRules).toBeUndefined();
    expect(without?.color).toBe(withRules?.color);
    expect(without?.sentence).toBe(withRules?.sentence);
  });
});

describe('OrgManager.cleanUpIgnoredRules', () => {
  it('removes the ignored local rules only, refreshes health and returns the count', async () => {
    const shared = JSON.stringify({ permissions: { allow: ['Bash(python *)'] } });
    fs.writeFileSync(path.join(hqDir, '.claude', 'settings.json'), shared);
    fs.writeFileSync(local(), JSON.stringify({ effortLevel: 'high', permissions: { allow: ['Bash(rm *)', 'WebFetch', 'Bash(make test)'] } }));
    await manager.refreshHealth(orgId, false);
    events = [];
    await expect(manager.cleanUpIgnoredRules(orgId)).resolves.toBe(2);
    expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({ effortLevel: 'high', permissions: { allow: ['Bash(make test)'] } });
    expect(fs.readFileSync(path.join(hqDir, '.claude', 'settings.json'), 'utf8')).toBe(shared);
    expect(healthEvents().at(-1)?.status.droppedRules).toEqual({ local: [], project: ['Bash(python *)'] });
  });

  it('rejects for an unknown org, a missing file and a damaged file, writing nothing', async () => {
    await expect(manager.cleanUpIgnoredRules('nope')).rejects.toThrow();
    await expect(manager.cleanUpIgnoredRules(orgId)).rejects.toThrow();
    expect(fs.existsSync(local())).toBe(false);
    fs.writeFileSync(local(), '{ broken');
    await expect(manager.cleanUpIgnoredRules(orgId)).rejects.toThrow();
    expect(fs.readFileSync(local(), 'utf8')).toBe('{ broken');
  });

  it('returns 0 when nothing is ignored', async () => {
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }));
    await expect(manager.cleanUpIgnoredRules(orgId)).resolves.toBe(0);
  });
});
