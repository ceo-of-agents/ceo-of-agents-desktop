import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type BrokerRequest } from '../../src/main/claude/permissions';
import { handleMessage } from '../../src/mcp/permission-server';

let tmp: string;
let bundle: string;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-b-'));
  bundle = path.join(tmp, 'permission-server.js');
  await build({
    entryPoints: [path.join(__dirname, '..', '..', 'src', 'mcp', 'permission-server.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('handleMessage', () => {
  const fwd = async () => ({ behavior: 'allow' });
  it('answers the handshake', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, fwd)).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, fwd)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'coa', version: '0.1.0' } },
    });
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fwd)).toBeNull();
    const list = (await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, fwd)) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['permission_prompt']);
  });
  it('denies when the app cannot be reached', async () => {
    const res = (await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'permission_prompt', arguments: { tool_name: 'Write', input: {} } } },
      async () => {
        throw new Error('ENOENT');
      },
    )) as { result: { content: Array<{ text: string }> } };
    const d = JSON.parse(res.result.content[0].text);
    expect(d.behavior).toBe('deny');
    expect(d.message).toContain('ENOENT');
  });
});

describe('broker + MCP server', () => {
  let broker: PermissionBroker;
  let hq: string;
  let proc: ChildProcessWithoutNullStreams;
  let nextId = 10;
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  let socketPath: string;
  let config: { command: string; args: string[]; env: Record<string, string> };
  const requests: BrokerRequest[] = [];
  let userDeny: string[] = [];

  async function startServer(token?: string) {
    const env = { ...process.env, ...config.env };
    if (token !== undefined) env.COA_PERM_TOKEN = token;
    proc = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>; // throws if anything but JSON is on stdout
        buf = buf.slice(i + 1);
        waiters.get(m.id as number)?.(m);
      }
    });
  }
  const rpc = (method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (tool_name: string, input: unknown) => {
    const res = (await rpc('tools/call', { name: 'permission_prompt', arguments: { tool_name, input, tool_use_id: 'toolu_1' } })) as {
      result: { content: Array<{ text: string }> };
    };
    return JSON.parse(res.result.content[0].text) as { behavior: string; updatedInput?: unknown; message?: string };
  };
  const nextRequest = () =>
    new Promise<BrokerRequest>((resolve) => {
      if (requests.length) return resolve(requests.shift() as BrokerRequest);
      broker.once('request', () => resolve(requests.shift() as BrokerRequest));
    });

  beforeEach(async () => {
    hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hq-'));
    socketPath = path.join(tmp, `s${Math.random().toString(36).slice(2, 8)}.sock`);
    fs.writeFileSync(socketPath, 'stale');
    userDeny = [];
    broker = new PermissionBroker({ userDeny: () => userDeny });
    requests.length = 0;
    broker.on('request', (r: BrokerRequest) => requests.push(r));
    await broker.start(socketPath);
    config = JSON.parse(broker.register('cos', { serverScript: bundle, nodePath: process.execPath, cwd: hq })).mcpServers.coa;
  });
  afterEach(async () => {
    proc?.kill();
    waiters.clear();
    await broker.stop();
    fs.rmSync(hq, { recursive: true, force: true });
  });

  it('returns the MCP config', () => {
    expect(config.command).toBe(process.execPath);
    expect(config.args).toEqual([bundle]);
    expect(config.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(config.env.COA_PERM_SOCKET).toBe(socketPath);
    expect(config.env.COA_PERM_TOKEN).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('proposes no rule for a thread registered with noRule (setup wizard)', async () => {
    const cfg = JSON.parse(broker.register('setup', { serverScript: bundle, nodePath: process.execPath, cwd: hq, noRule: true })).mcpServers.coa;
    await startServer(cfg.env.COA_PERM_TOKEN);
    const input = { file_path: path.join(hq, 'inbox', 'n.md'), content: 'x' };
    const p = call('Write', input);
    const req = await nextRequest();
    expect(req).toMatchObject({ threadKey: 'setup', toolName: 'Write', rule: '' });
    broker.respond(req.requestId, 'allow');
    expect(await p).toEqual({ behavior: 'allow', updatedInput: input });
    expect(fs.existsSync(path.join(hq, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('an Artifact publish request has a readable summary and no Always allow proposal', async () => {
    await startServer();
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const input = { action: 'publish', file_path: '/abs/file.html', title: 'Capture test', icon: 'code', __artifactPlanConsentAsk: true, __artifactPublishTarget: 'x' };
    const p = call('Artifact', input);
    const req = await nextRequest();
    expect(req).toMatchObject({ threadKey: 'cos', toolName: 'Artifact', summary: 'Publish the artifact "Capture test"', rule: '' });
    broker.respond(req.requestId, 'allow');
    expect(await p).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('handshake, allow, deny and always', async () => {
    await startServer();
    expect(await rpc('server/discover')).toMatchObject({ error: { code: -32601 } });
    expect(await rpc('initialize', { protocolVersion: '2025-06-18' })).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = (await rpc('tools/list')) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools[0].name).toBe('permission_prompt');

    const input = { file_path: path.join(hq, 'inbox', 'n.md'), content: 'x' };
    // allow
    let p = call('Write', input);
    let req = await nextRequest();
    expect(req).toMatchObject({ threadKey: 'cos', toolName: 'Write', summary: 'Write inbox/n.md', rule: 'Edit(/inbox/n.md)' });
    expect(broker.pending('cos')).toHaveLength(1);
    broker.respond(req.requestId, 'allow');
    expect(await p).toEqual({ behavior: 'allow', updatedInput: input });
    expect(broker.pending('cos')).toHaveLength(0);
    expect(fs.existsSync(path.join(hq, '.claude', 'settings.local.json'))).toBe(false);

    // deny
    p = call('Write', input);
    req = await nextRequest();
    broker.respond(req.requestId, 'deny');
    expect(await p).toEqual({ behavior: 'deny', message: 'The user denied this in the app.' });

    // always, then the exact same call goes through without a request
    p = call('Bash', { command: 'git push origin main' });
    req = await nextRequest();
    expect(req.rule).toBe('Bash(git push origin main)');
    broker.respond(req.requestId, 'always', 'Bash(git push origin main)');
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    const settings = JSON.parse(fs.readFileSync(path.join(hq, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(git push origin main)']);
    expect(await call('Bash', { command: 'git push origin main' })).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    expect(requests).toHaveLength(0);
    // ...but a different input of the same rule still asks: the app does not parse commands to allow them
    for (const command of ['git push -f', 'git push origin main && ls', 'git  push origin main']) {
      p = call('Bash', { command });
      req = await nextRequest();
      broker.respond(req.requestId, 'deny');
      expect((await p).behavior).toBe('deny');
    }
    // commands Claude Code asks about always prompt, whatever the old baseline said (no app-side allow)
    for (const command of ['git status', 'ls']) {
      p = call('Bash', { command });
      req = await nextRequest();
      broker.respond(req.requestId, 'deny');
      await p;
    }
    p = call('Read', { file_path: 'a.md' });
    req = await nextRequest();
    expect(req.rule).toBe('');
    broker.respond(req.requestId, 'deny');
    await p;

    // an invalid edited rule keeps the proposal; a valid edit is saved
    p = call('Bash', { command: 'npm run build' });
    req = await nextRequest();
    broker.respond(req.requestId, 'always', 'Bash(*)');
    await p;
    p = call('Bash', { command: 'make test' });
    req = await nextRequest();
    broker.respond(req.requestId, 'always', 'Bash(make test)');
    await p;
    const after = JSON.parse(fs.readFileSync(path.join(hq, '.claude', 'settings.local.json'), 'utf8'));
    expect(after.permissions.allow).toEqual(['Bash(git push origin main)', 'Bash(npm run build *)', 'Bash(make test)']);

    // no proposal: Always allow is an Allow once, nothing written, nothing remembered
    const clever = { command: 'echo $(date)' };
    p = call('Bash', clever);
    req = await nextRequest();
    expect(req.rule).toBe('');
    broker.respond(req.requestId, 'always', 'Bash(echo *)');
    expect(await p).toEqual({ behavior: 'allow', updatedInput: clever });
    expect(JSON.parse(fs.readFileSync(path.join(hq, '.claude', 'settings.local.json'), 'utf8')).permissions.allow).toEqual(after.permissions.allow);
    p = call('Bash', clever);
    req = await nextRequest();
    broker.respond(req.requestId, 'deny');
    await p;

    // an edited rule that is broader than any proposal is replaced by the proposal
    p = call('Bash', { command: 'git commit -m x' });
    req = await nextRequest();
    broker.respond(req.requestId, 'always', 'Bash(sh *)');
    await p;
    expect(JSON.parse(fs.readFileSync(path.join(hq, '.claude', 'settings.local.json'), 'utf8')).permissions.allow).toContain('Bash(git commit *)');

    // the hq's deny rules and the user's deny rules win; allow rules in the hq files do not skip the prompt
    fs.writeFileSync(path.join(hq, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make *)'], deny: ['Bash(git push *)'] } }));
    const blocked = await call('Bash', { command: 'git push origin main' });
    expect(blocked.behavior).toBe('deny');
    expect(String(blocked.message)).toContain('Bash(git push *)');
    userDeny = ['Read(//etc/**)'];
    const userBlocked = await call('Read', { file_path: '/etc/hosts' });
    expect(userBlocked.behavior).toBe('deny');
    expect(String(userBlocked.message)).toContain('Read(//etc/**)');
    expect(requests).toHaveLength(0);
  });

  describe('AskUserQuestion', () => {
    const input = {
      questions: [
        { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite (Recommended)', description: 'Local' }, { label: 'Postgres', description: '' }] },
        { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }] },
      ],
    };
    const answers = { 'Which database?': 'Postgres', 'Which checks?': 'Lint, Tests' };
    const ask = async () => {
      await startServer();
      await rpc('initialize', {});
      const p = call('AskUserQuestion', input);
      return { p, req: await nextRequest() };
    };

    it('shows a card with no rule proposal and answers with the original input plus the answers', async () => {
      const { p, req } = await ask();
      expect(req).toMatchObject({ toolName: 'AskUserQuestion', rule: '', summary: 'Which database? (+1 more)' });
      expect(broker.answer(req.requestId, answers)).toBe(true);
      expect(await p).toEqual({ behavior: 'allow', updatedInput: { ...input, answers } });
      expect(broker.pending('cos')).toHaveLength(0);
    });

    it('refuses answers with a wrong key, a missing or extra key, or an empty value, and keeps the request pending', async () => {
      const { p, req } = await ask();
      for (const bad of [
        { 'Which database?': 'Postgres', 'Other question?': 'x' },
        { 'Which database?': 'Postgres' },
        { ...answers, extra: 'x' },
        { ...answers, 'Which checks?': '  ' },
        { ...answers, 'Which checks?': 5 },
        null,
        [],
      ]) {
        expect(broker.answer(req.requestId, bad as never)).toBe(false);
      }
      expect(broker.pending('cos')).toHaveLength(1);
      expect(broker.answer('nope', answers)).toBe(false);
      broker.respond(req.requestId, 'deny');
      await p;
    });

    it('answer refuses a request that is not a question', async () => {
      await startServer();
      await rpc('initialize', {});
      const p = call('Bash', { command: 'rm x' });
      const req = await nextRequest();
      expect(broker.answer(req.requestId, answers)).toBe(false);
      expect(broker.pending('cos')).toHaveLength(1);
      broker.respond(req.requestId, 'deny');
      await p;
    });

    it('answer refuses a question call whose input is malformed', async () => {
      await startServer();
      await rpc('initialize', {});
      const p = call('AskUserQuestion', { questions: 'x' });
      const req = await nextRequest();
      expect(broker.answer(req.requestId, answers)).toBe(false);
      broker.respond(req.requestId, 'deny');
      await p;
    });

    it('respond allow or always on a question returns false and sends nothing; deny sends the question message', async () => {
      const { p, req } = await ask();
      expect(broker.respond(req.requestId, 'allow')).toBe(false);
      expect(broker.respond(req.requestId, 'always', 'AskUserQuestion')).toBe(false);
      expect(broker.pending('cos')).toHaveLength(1);
      expect(broker.respond(req.requestId, 'deny')).toBe(true);
      expect(await p).toEqual({ behavior: 'deny', message: 'The user chose not to answer the questions.' });
    });

    it('a question the app cannot parse (5 questions) stays pending as the fallback card, and Allow, Always and Deny all send a plain-text message', async () => {
      const tooMany = { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, header: `H${i}`, multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] })) };
      await startServer();
      await rpc('initialize', {});
      for (const decision of ['allow', 'always', 'deny'] as const) {
        const p = call('AskUserQuestion', tooMany);
        const req = await nextRequest();
        expect(broker.pending('cos')).toHaveLength(1);
        expect(broker.answer(req.requestId, { 'Q0?': 'A' })).toBe(false);
        expect(broker.respond(req.requestId, decision, 'AskUserQuestion')).toBe(true);
        expect(await p).toEqual({ behavior: 'deny', message: 'The app could not show this question; ask it again in plain text.' });
        expect(broker.pending('cos')).toHaveLength(0);
      }
    });

    it('other malformed shapes (more than 8 options, duplicate labels) take the same fallback path', async () => {
      const q = (options: Array<{ label: string; description: string }>) => ({ questions: [{ question: 'Pick?', header: 'Pick', multiSelect: false, options }] });
      const many = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, description: '' }));
      await startServer();
      await rpc('initialize', {});
      for (const bad of [q(many), q([{ label: 'Same', description: '' }, { label: 'Same', description: '' }])]) {
        const p = call('AskUserQuestion', bad);
        const req = await nextRequest();
        expect(broker.respond(req.requestId, 'allow')).toBe(true);
        expect((await p).behavior).toBe('deny');
      }
    });

    it('is never auto-allowed: asking twice shows a card twice, even after Always allow on other tools', async () => {
      await startServer();
      await rpc('initialize', {});
      let p = call('Bash', { command: 'make test' });
      let req = await nextRequest();
      broker.respond(req.requestId, 'always', 'Bash(make test)');
      await p;
      for (let i = 0; i < 2; i++) {
        p = call('AskUserQuestion', input);
        req = await nextRequest();
        expect(req.toolName).toBe('AskUserQuestion');
        expect(broker.answer(req.requestId, answers)).toBe(true);
        expect((await p).behavior).toBe('allow');
      }
    });
  });

  it('forgetRule: after the saved rule is removed, an exact repeat asks again; other rules stay remembered', async () => {
    await startServer();
    await rpc('initialize', {});
    const approve = async (command: string, rule: string) => {
      const p = call('Bash', { command });
      const req = await nextRequest();
      broker.respond(req.requestId, 'always', rule);
      await p;
    };
    await approve('git push origin main', 'Bash(git push origin main)');
    await approve('make test', 'Bash(make test)');
    // both repeats are allowed without a card
    expect((await call('Bash', { command: 'git push origin main' })).behavior).toBe('allow');
    expect((await call('Bash', { command: 'make test' })).behavior).toBe('allow');
    expect(requests).toHaveLength(0);

    expect(broker.forgetRule(hq, 'Bash(nothing)')).toBe(0);
    expect(broker.forgetRule('/tmp/another-hq', 'Bash(git push origin main)')).toBe(0);
    expect(broker.forgetRule(hq, 'Bash(git push origin main)')).toBe(1);
    expect(broker.forgetRule(hq, 'Bash(git push origin main)')).toBe(0);

    // the forgotten one asks again; the other is still allowed
    const p = call('Bash', { command: 'git push origin main' });
    const req = await nextRequest();
    broker.respond(req.requestId, 'deny');
    expect((await p).behavior).toBe('deny');
    expect((await call('Bash', { command: 'make test' })).behavior).toBe('allow');
    expect(requests).toHaveLength(0);
  });

  it('denyPending denies and resolves the requests of one thread and keeps it registered', async () => {
    await startServer();
    await rpc('initialize', {});
    const p = call('Bash', { command: 'rm x' });
    const req = await nextRequest();
    const resolved: string[] = [];
    broker.on('resolved', (id: string) => resolved.push(id));
    expect(broker.denyPending('other')).toBe(0);
    expect(broker.pending('cos')).toHaveLength(1);
    expect(broker.denyPending('cos')).toBe(1);
    const d = await p;
    expect(d.behavior).toBe('deny');
    expect(String(d.message)).toContain('cancelled');
    expect(resolved).toEqual([req.requestId]);
    expect(broker.pending('cos')).toHaveLength(0);
    // still registered: the next request is a normal prompt
    const p2 = call('Bash', { command: 'rm y' });
    const req2 = await nextRequest();
    broker.respond(req2.requestId, 'allow');
    expect((await p2).behavior).toBe('allow');
  });

  it('denies an unknown token', async () => {
    await startServer('not-a-token');
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const d = await call('Write', { file_path: 'a.md' });
    expect(d.behavior).toBe('deny');
    expect(requests).toHaveLength(0);
  });

  it('unregister denies pending requests', async () => {
    await startServer();
    await rpc('initialize', {});
    const p = call('Bash', { command: 'rm x' });
    await nextRequest();
    broker.unregister('cos');
    expect((await p).behavior).toBe('deny');
    expect(broker.pending('cos')).toHaveLength(0);
  });

  it('denies clearly when the socket is gone', async () => {
    await startServer();
    await rpc('initialize', {});
    await broker.stop();
    const d = await call('Bash', { command: 'rm x' });
    expect(d.behavior).toBe('deny');
    expect(d.message).toContain('Could not reach the app');
    await broker.start(socketPath);
  });
});
