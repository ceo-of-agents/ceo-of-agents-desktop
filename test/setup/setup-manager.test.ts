import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Runner, Spawner } from '../../src/main/system/exec';
import { run } from '../../src/main/system/exec';
import { RunGuard } from '../../src/main/org/run-guard';
import { SetupManager, readRules, sweepAnswersDirs } from '../../src/main/setup/setup-manager';
import { SETUP_ORG_ID, type SetupAnswers, type SetupState } from '../../src/shared/setup';
import type { OrgSummary } from '../../src/shared/types';
import type { AppEvent } from '../../src/shared/types';
import { FAKE_ORG, waitFor } from '../org/helpers';

vi.mock('electron', () => ({ dialog: {}, app: {} }));

const PLUGIN = path.join(__dirname, '..', 'fixtures', 'setup-plugin');

let root: string;
let folder: string;
let events: AppEvent[];
let log: string;
let manager: SetupManager;
let spawns: number;

const answers = (): SetupAnswers => ({
  schema: 'setup-answers/1',
  language: { chat: 'en', files: 'en' },
  org: { purpose: 'personal', level: 'company', id: 'ME', name: 'Me' },
  ceo: { profile: 'technical' },
  about: { what: 'w', why: 'y', stage: 'setting up' },
  departments: [{ from: 'catalog', id: 'engineering' }],
  names: { cos: 'Ada', ceo: 'later', departments: { engineering: 'Max' } },
  gates: 'accept',
  models: { cos: 'opus', departments: 'opus' },
  remote: { hq: 'none' },
  attribution: 'default',
  enable_plugin: true,
});

/** `claude plugin list --json` answers with the fixture plugin; everything else (git) runs for real. */
const runner: Runner = (cmd, args, opts) => {
  if (args[0] === 'plugin') return Promise.resolve({ code: 0, stdout: JSON.stringify([{ id: 'ceo-of-agents@ceo-of-agents', version: '9.9.9', installPath: PLUGIN }]), stderr: '', error: null });
  return run(cmd, args, opts);
};

function make(over: { canStart?: () => string | null; claude?: string | null; delayMs?: number; addFromFolder?: (dir: string) => OrgSummary | null; runner?: Runner } = {}): SetupManager {
  const spawner: Spawner = (_c, a, opts) => {
    spawns++;
    return spawn(process.execPath, [FAKE_ORG, ...a], { ...opts, env: { ...process.env, FAKE_LOG: log, FAKE_REPLY: 'done', FAKE_DELAY_MS: String(over.delayMs ?? 0) } });
  };
  return new SetupManager({
    dataDir: path.join(root, 'data'),
    broker: { register: () => '{}', unregister: () => undefined } as never,
    serverScript: 's',
    nodePath: 'node',
    emit: (e) => events.push(e),
    claudePath: () => (over.claude === undefined ? 'claude' : over.claude),
    canStart: over.canStart ?? (() => null),
    addFromFolder: over.addFromFolder ?? (() => null),
    runner: over.runner ?? runner,
    spawner,
  });
}

const states = () => events.filter((e): e is Extract<AppEvent, { type: 'setup-state' }> => e.type === 'setup-state');
const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-setup-mgr-')));
  folder = path.join(root, 'new-org');
  fs.mkdirSync(folder);
  log = path.join(root, 'fake.log');
  events = [];
  spawns = 0;
  manager = make();
});
afterEach(async () => {
  await manager.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SetupManager', () => {
  it('refuses a missing folder and a non-empty one, listing what is inside', async () => {
    expect(await manager.start(answers(), path.join(root, 'nope'))).toEqual({ error: expect.stringContaining('does not exist') });
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    expect(await manager.start(answers(), folder)).toEqual({ error: expect.stringContaining('notes.txt') });
    expect(spawns).toBe(0);
  });

  it('does not start when sessions may not start or claude is missing', async () => {
    expect(await make({ canStart: () => 'not signed in' }).start(answers(), folder)).toEqual({ error: 'not signed in' });
    expect(await make({ claude: null }).start(answers(), folder)).toHaveProperty('error');
  });

  it('writes the answers file (mode 600) and sends the init-fleet call as the first message', async () => {
    const r = await manager.start(answers(), folder);
    expect('runId' in r).toBe(true);
    const runId = (r as { runId: string }).runId;
    await waitFor(() => logged().includes('init-fleet'));
    const line = logged().split('\n').find((l) => l.includes('init-fleet')) as string;
    const text = JSON.parse(line).message.content as Array<{ text: string }> | string;
    const message = typeof text === 'string' ? text : text[0].text;
    const m = /^\/ceo-of-agents:init-fleet (\S+)$/.exec(message);
    expect(m).not.toBeNull();
    const file = (m as RegExpExecArray)[1];
    expect(path.basename(file)).toBe('answers.yaml');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schema: 'setup-answers/1', org: { id: 'ME' } });
    // The first message is the skill call: it is not in the thread the CEO sees.
    expect(manager.thread(runId)?.entries.some((e) => 'text' in e && String(e.text).includes('init-fleet'))).toBe(false);
    // The args carry the answers folder and the plugin folder.
    const args = JSON.parse((logged().split('\n').find((l) => l.startsWith('ARGS ')) as string).slice(5)) as string[];
    // Read access to the answers folder by a rule, not `--add-dir` (which would allow writes there too).
    expect(args).not.toContain('--add-dir');
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(expect.arrayContaining(readRules(path.dirname(file))));
    expect(readRules(path.dirname(file))[0]).toMatch(/^Read\(\/\/.*\/\*\*\)$/);
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(PLUGIN);
    expect((await manager.status(runId))?.answersFile).toBe(file);
  });

  it('refuses a second start while one runs, and a concurrent one', async () => {
    const [a, b] = await Promise.all([manager.start(answers(), folder), manager.start(answers(), folder)]);
    expect([a, b].filter((x) => 'runId' in x)).toHaveLength(1);
    expect([a, b].find((x) => 'error' in x)).toEqual({ error: expect.stringContaining('Another org') });
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    expect(await manager.start(answers(), other)).toHaveProperty('error');
  });

  it('stop deletes the answers folder and the thread log, and frees the manager', async () => {
    const { runId } = (await manager.start(answers(), folder)) as { runId: string };
    const file = (await manager.status(runId))?.answersFile as string;
    await waitFor(() => logged().includes('init-fleet'));
    expect(fs.existsSync(file)).toBe(true);
    await manager.stop(runId);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(await manager.status(runId)).toBeNull();
    expect(manager.thread(runId)).toBeNull();
    expect(states().at(-1)).toMatchObject({ runId, busy: false, exited: true });
    expect(await manager.start(answers(), folder)).toHaveProperty('runId');
  });

  it('detects the milestones from the folder when a turn ends and in status()', async () => {
    const { runId } = (await manager.start(answers(), folder)) as { runId: string };
    await waitFor(() => logged().includes('init-fleet'));
    expect((await manager.status(runId))?.facts).toMatchObject({ orgYaml: false, commit: null, orgName: null });
    // The wizard writes files and commits; the next turn end (or status()) sees them.
    fs.writeFileSync(path.join(folder, 'org.yaml'), 'org:\n  id: ME\n  name: Me\ncos:\n  display_name: Ada\n');
    fs.mkdirSync(path.join(folder, 'company'));
    fs.writeFileSync(path.join(folder, 'company', 'state.md'), '# s');
    const g = (...a: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: folder });
    await g('init', '--quiet');
    await g('add', '-A');
    await g('commit', '--quiet', '-m', 'init');
    const s = (await manager.status(runId)) as SetupState;
    expect(s.facts).toMatchObject({ orgYaml: true, state: true, decisionRecord: false, orgName: 'Me', cosName: 'Ada' });
    expect(s.facts.commit).toMatch(/^[0-9a-f]{4,40}$/);
    // A message starts a new turn; when it ends the emitted state carries the new facts.
    events.length = 0;
    manager.send(runId, 'hello');
    await waitFor(() => states().some((e) => e.facts.orgYaml && e.facts.commit !== null && !e.busy));
  });

  it('never installs the plugin on its own: without it the run does not start', async () => {
    let installs = 0;
    const noPlugin: Runner = (cmd, args, opts) => {
      if (args[0] === 'plugin' && args[1] === 'install') installs++;
      if (args[0] === 'plugin') return Promise.resolve({ code: 0, stdout: '[]', stderr: '', error: null });
      return run(cmd, args, opts);
    };
    const r = await make({ runner: noPlugin }).start(answers(), folder);
    expect(r).toEqual({ error: expect.stringContaining('plugin is not installed') });
    expect(installs).toBe(0);
    expect(spawns).toBe(0);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('refuses a symlinked folder, and a symlinked .claude', async () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(folder, link);
    expect(await manager.start(answers(), link)).toEqual({ error: expect.stringContaining('link') });
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(folder, path.join(other, '.claude'));
    expect(await manager.start(answers(), other)).toEqual({ error: expect.stringContaining('link') });
    expect(spawns).toBe(0);
  });

  it('refuses a policies repo path that is the picked folder, inside it, or an existing folder with content', async () => {
    const holding = (p: string): SetupAnswers => ({ ...answers(), org: { purpose: 'company', level: 'holding', id: 'H', name: 'H' }, policies_repo: { path: p, remote: 'none' } });
    expect(await manager.start(holding(folder), folder)).toEqual({ error: expect.stringContaining('policies repo') });
    expect(await manager.start(holding(path.join(folder, 'policies')), folder)).toEqual({ error: expect.stringContaining('policies repo') });
    const full = path.join(root, 'full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'a.txt'), 'x');
    expect(await manager.start(holding(full), folder)).toEqual({ error: expect.stringContaining('already has content') });
    expect(spawns).toBe(0);
    // A new path, or an empty existing folder next to it, is fine.
    const empty = path.join(root, 'empty-policies');
    fs.mkdirSync(empty);
    expect(await manager.start(holding(empty), folder)).toHaveProperty('runId');
  });

  it('finish deletes the answers file and adds the org from its folder', async () => {
    const added: string[] = [];
    const m = make({ addFromFolder: (dir) => (added.push(dir), null) });
    try {
      const { runId } = (await m.start(answers(), folder)) as { runId: string };
      const file = (await m.status(runId))?.answersFile as string;
      expect(fs.existsSync(file)).toBe(true);
      await m.finish(runId);
      expect(added).toEqual([folder]);
      expect(fs.existsSync(path.dirname(file))).toBe(false);
      expect(await m.status(runId)).toBeNull();
    } finally {
      await m.shutdown();
    }
  });

  it('the setup org is in the quit guard while the wizard replies, and a forced stop ends it', async () => {
    const m = make({ delayMs: 400 });
    const stopped: string[] = [];
    const guard = new RunGuard({
      items: (scope) => (scope === 'all' ? m.runningItems() : []),
      ask: async () => 'stop',
      forceStop: async (orgId) => {
        stopped.push(orgId);
        if (orgId === SETUP_ORG_ID) await m.shutdown();
      },
      notePending: () => undefined,
    });
    try {
      expect(m.runningItems()).toEqual([]);
      const { runId } = (await m.start(answers(), folder)) as { runId: string };
      await waitFor(() => m.runningItems().length === 1);
      expect(m.runningItems()[0]).toMatchObject({ orgId: SETUP_ORG_ID, kind: 'cos-turn' });
      expect(guard.hasItems('all')).toBe(true);
      let ran = false;
      expect(await guard.run('all', 'Quit', () => void (ran = true))).toBe('done');
      expect(stopped).toEqual([SETUP_ORG_ID]);
      expect(ran).toBe(true);
      expect(m.runningItems()).toEqual([]);
      expect(await m.status(runId)).toBeNull();
    } finally {
      await m.shutdown();
    }
  });
});

describe('sweepAnswersDirs', () => {
  const mk = (name: string, files: string[], ageMs: number): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  };
  it('removes old leftover answers folders only: exact name shape, only answers.yaml, older than the start', () => {
    const old = mk('coa-setup-aB3dE9', ['answers.yaml'], 3_600_000);
    const withOther = mk('coa-setup-aB3dE8', ['answers.yaml', 'notes.txt'], 3_600_000);
    const fresh = mk('coa-setup-aB3dE7', ['answers.yaml'], -60_000);
    const otherName = mk('coa-setup-mgr-aB3dE9', ['answers.yaml'], 3_600_000);
    const unrelated = mk('something-else', ['answers.yaml'], 3_600_000);
    expect(sweepAnswersDirs(root, Date.now())).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    for (const kept of [withOther, fresh, otherName, unrelated]) expect(fs.existsSync(kept)).toBe(true);
  });
  it('never throws for a missing temp folder', () => {
    expect(sweepAnswersDirs(path.join(root, 'nope'), Date.now())).toBe(0);
  });
});
