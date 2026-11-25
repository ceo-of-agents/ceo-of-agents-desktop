import { describe, expect, it } from 'vitest';
import { ASK_FIX_GRACE_MS, askFixNext, claimAskFix, fixAgentFileMessage, fixHqMessage, fixOrgYamlMessage, type AskFixPending } from '../../src/renderer/logic';

describe('fixHqMessage', () => {
  it('asks for a diagnosis and a plan, and to wait for an OK, for both kinds', () => {
    for (const kind of ['diverged', 'files'] as const) {
      const m = fixHqMessage(kind);
      expect(m).toMatch(/plan/);
      expect(m).toMatch(/Do not discard, overwrite or force-push anything, here or on GitHub, until I give my OK\./);
      expect(m).not.toMatch(/reconcile them for me|what you chose to keep/i);
    }
  });
  it('tells a divergence from a real conflict', () => {
    expect(fixHqMessage('diverged')).toMatch(/both have new changes/);
    expect(fixHqMessage('diverged')).not.toMatch(/conflict/);
    expect(fixHqMessage('files')).toMatch(/conflict: this hq and GitHub have different changes to the same files/);
    expect(fixHqMessage('files')).toMatch(/which files, and what each side changed/);
  });
});

describe('askFixNext (the guard against a second request)', () => {
  const sentAt = 1_000_000;
  const p: AskFixPending = { sentAt, sawTurn: false };

  it('stays pending while queued behind an earlier turn, and that turn ending does not clear it', () => {
    const earlier = sentAt - 5_000;
    let s = askFixNext(p, true, earlier, sentAt + 100);
    expect(s).toEqual(p);
    s = askFixNext(s, false, null, sentAt + 200); // the earlier turn ended; ours has not started
    expect(s).toEqual(p);
  });

  it('clears when the turn that started after the send ends', () => {
    let s = askFixNext(p, true, sentAt + 50, sentAt + 100);
    expect(s).toEqual({ sentAt, sawTurn: true });
    s = askFixNext(s, true, sentAt + 50, sentAt + 60_000); // still running, long after the grace time
    expect(s).toEqual({ sentAt, sawTurn: true });
    expect(askFixNext(s, false, null, sentAt + 61_000)).toBeNull();
  });

  it('counts the next turn by its start time even with no idle gap between turns', () => {
    let s = askFixNext(p, true, sentAt - 1, sentAt + 10);
    expect(s?.sawTurn).toBe(false);
    s = askFixNext(s, true, sentAt + 20, sentAt + 30);
    expect(s?.sawTurn).toBe(true);
  });

  it('gives up after the grace time only when idle and no turn started', () => {
    expect(askFixNext(p, false, null, sentAt + ASK_FIX_GRACE_MS - 1)).toEqual(p);
    expect(askFixNext(p, false, null, sentAt + ASK_FIX_GRACE_MS)).toBeNull();
    expect(askFixNext(p, true, sentAt - 1, sentAt + ASK_FIX_GRACE_MS * 3)).toEqual(p); // busy with an earlier turn: keep waiting
  });

  it('nothing pending stays nothing', () => {
    expect(askFixNext(null, true, sentAt, sentAt)).toBeNull();
  });
});

describe('fixOrgYamlMessage and fixAgentFileMessage (diagnose, put the fix on a decision card, wait for the OK)', () => {
  const messages = {
    orgYaml: fixOrgYamlMessage('Line 23: All mapping items must start at the same column'),
    agentFile: fixAgentFileMessage('Max', '.claude/agents/max.md'),
  };

  it('name what is wrong and where, as the health messages do', () => {
    expect(messages.orgYaml).toMatch(/could not read org\.yaml in this hq \(Line 23: All mapping items must start at the same column\)/);
    expect(messages.orgYaml).toMatch(/Please diagnose it: what is wrong and where in the file/);
    expect(messages.agentFile).toMatch(/agent file of Max is missing: \.claude\/agents\/max\.md was not found in this hq/);
    expect(messages.agentFile).toMatch(/Please diagnose it: why the file is missing/);
  });

  it('ask for the proposed fix on a decision card, saying why', () => {
    expect(messages.orgYaml).toMatch(/propose a fix and put it on a decision card, because org\.yaml changes only through a decision in the hq/);
    expect(messages.agentFile).toMatch(/propose a fix and put it on a decision card, because agent files change only through a decision in the hq/);
  });

  it('say no file changes until the OK, and the diagnosis comes before the fix', () => {
    for (const m of Object.values(messages)) {
      expect(m).toMatch(/Do not change any file until I give my OK\.$/);
      expect(m.indexOf('diagnose')).toBeGreaterThanOrEqual(0);
      expect(m.indexOf('diagnose')).toBeLessThan(m.indexOf('decision card'));
      expect(m).not.toMatch(/Do not change anything until/);
    }
  });
});

describe('claimAskFix (the synchronous half of the guard)', () => {
  it('lets the first click through and blocks a second one before any state update', () => {
    const claimed = new Set<string>();
    expect(claimAskFix(claimed, 'acme', false)).toBe(true);
    expect(claimAskFix(claimed, 'acme', false)).toBe(false); // the state still says "not pending"
  });

  it('is per org, and releasing brings it back', () => {
    const claimed = new Set<string>();
    expect(claimAskFix(claimed, 'acme', false)).toBe(true);
    expect(claimAskFix(claimed, 'bolt', false)).toBe(true);
    claimed.delete('acme');
    expect(claimAskFix(claimed, 'acme', false)).toBe(true);
  });

  it('a request the state already shows as pending is blocked and not claimed', () => {
    const claimed = new Set<string>();
    expect(claimAskFix(claimed, 'acme', true)).toBe(false);
    expect(claimed.size).toBe(0);
  });
});
