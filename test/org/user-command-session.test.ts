import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgSession, type CommandConfirm, type OrgSessionDeps } from '../../src/main/org/org-session';
import { ClaudeSession } from '../../src/main/claude/session';
import { startUserCommand } from '../../src/main/system/user-command';
import type { AppEvent } from '../../src/shared/types';
import { fakeFactory, waitFor } from './helpers';

let root: string;
let hq: string;
const orgs: OrgSession[] = [];
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-cmd-org-')));
  hq = path.join(root, 'hq');
  fs.mkdirSync(path.join(hq, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(hq, 'org.yaml'), 'org:\n  id: T\n  name: Test Org\ncos:\n  display_name: "Ada"\ndepartments: []\n');
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), '# Test\n');
  fs.writeFileSync(path.join(hq, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(git push --force *)'] } }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(orgs.splice(0).map((o) => o.stopAll()));
  fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const events: AppEvent[] = [];
  const started: Array<{ command: string; cwd: string }> = [];
  const deps: OrgSessionDeps = {
    claudePath: () => 'claude',
    settings: () => ({ permissionMode: 'default', effort: 'high', cosModel: 'opus' }) as never,
    broker: { register: () => '{}', unregister: () => {} } as never,
    serverScript: 'server.js',
    nodePath: process.execPath,
    canStart: () => null,
    emit: (e) => events.push(e),
    startCommand: (command, cwd) => {
      started.push({ command, cwd });
      return startUserCommand(command, { cwd, shell: '/bin/sh', killGraceMs: 200 });
    },
  };
  const org = new OrgSession('o1', hq, path.join(root, 'data'), deps);
  orgs.push(org);
  const factory = fakeFactory(hq);
  (org as any).makeSession = (_threadId: string, resumeId: string | null) => factory.makeSession(resumeId); // eslint-disable-line @typescript-eslint/no-explicit-any
  return { org, events, started };
}

const commandEntries = (org: OrgSession) => org.getThread('cos')!.entries.filter((e) => e.kind === 'command');

describe('OrgSession.runCommand', () => {
  it('runs nothing when the user declines, and shows the exact command, the hq folder and a matching deny rule', async () => {
    const { org, started } = setup();
    const seen: CommandConfirm[] = [];
    const ok = await org.runCommand('cos', 'git push --force origin main', async (c) => {
      seen.push(c);
      return false;
    });
    expect(ok).toBe(false);
    expect(seen).toEqual([{ command: 'git push --force origin main', folder: hq, speaker: 'Ada', deniedBy: 'Bash(git push --force *)' }]);
    expect(started).toEqual([]);
    expect(commandEntries(org)).toEqual([]);
  });

  it('runs in the hq folder, shows the output as the user, and passes it to the chief of staff with the next message', async () => {
    const { org, started } = setup();
    const sent = vi.spyOn(ClaudeSession.prototype, 'send');
    expect(await org.runCommand('cos', 'pwd; echo hi', async (c) => c.deniedBy === null)).toBe(true);
    expect(started).toEqual([{ command: 'pwd; echo hi', cwd: hq }]);
    await waitFor(() => commandEntries(org).length === 1);
    const [entry] = commandEntries(org);
    expect(entry).toMatchObject({ kind: 'command', author: 'You', text: 'pwd; echo hi', command: { outcome: 'done', exitCode: 0, stdout: `${hq}\nhi\n` } });
    expect(org.cos.state().commands).toEqual([]);
    // Nothing goes to Claude Code until the next message, which carries the output before its own text.
    expect(sent).not.toHaveBeenCalled();
    org.send('cos', 'what did you see?');
    await waitFor(() => sent.mock.calls.length === 1);
    expect(sent.mock.calls[0][0]).toBe(`<bash-input>pwd; echo hi</bash-input>\n<bash-stdout>${hq}\nhi</bash-stdout><bash-stderr></bash-stderr>\n\nwhat did you see?`);
    // The thread shows the message as typed, and the output goes only once.
    expect(org.getThread('cos')!.entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['what did you see?']);
    await waitFor(() => !org.cos.busy);
    org.send('cos', 'again');
    await waitFor(() => sent.mock.calls.length === 2);
    expect(sent.mock.calls[1][0]).toBe('again');
  });

  it('refuses a second command while one runs, and cancel stops it', async () => {
    const { org } = setup();
    expect(await org.runCommand('cos', 'sleep 30', async () => true)).toBe(true);
    await expect(org.runCommand('cos', 'echo x', async () => true)).rejects.toThrow(/already running/);
    const [running] = org.cos.state().commands!;
    expect(running.command).toBe('sleep 30');
    org.cancelCommand('cos', running.id);
    await waitFor(() => commandEntries(org).length === 1);
    expect(commandEntries(org)[0].command?.outcome).toBe('cancelled');
  });

  it('refuses hidden characters before asking', async () => {
    const { org } = setup();
    const confirm = vi.fn(async () => true);
    await expect(org.runCommand('cos', 'echo a\u202eb', confirm)).rejects.toThrow(/invisible/);
    await expect(org.runCommand('cos', '   ', confirm)).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled();
  });
});
