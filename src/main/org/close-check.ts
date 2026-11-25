// The check before the app quits or its window closes: department chats that have not handed over would lose their work.
// The dialog and the actions are injected, so the logic is tested without Electron.
import { t } from '../../shared/strings';
import type { OrgId, TabInfo } from '../../shared/types';

export interface ChatRef {
  orgId: OrgId;
  orgName: string;
  cosName: string;
  tab: TabInfo;
  /** A turn of the chat is running: it may do work that no flag shows yet, so it counts as pending. */
  busy?: boolean;
}

export interface CloseDialog {
  message: string;
  detail: string;
  /** Hand over, quit without handover, cancel. */
  buttons: [string, string, string];
  defaultId: number;
  cancelId: number;
}

/** The box shown while hand-overs run: one button that cancels the quit. */
export interface ProgressDialog {
  message: string;
  detail: string;
  cancel: string;
}

export interface CloseCheckDeps {
  /** Every department chat of every org that has a session, in any status. */
  chats(): ChatRef[];
  /** Shows the dialog and returns the index of the clicked button. */
  ask(dialog: CloseDialog): Promise<number>;
  handOver(orgId: OrgId, tabId: string): Promise<void>;
  /** Closes a chat for the quit WITHOUT passing its note to the chief of staff (no CoS turn is started: shutdown would kill it mid-turn). */
  closeQuiet(orgId: OrgId, tabId: string): Promise<void>;
  /**
   * Shows the progress box while hand-overs run and resolves when the user cancels the quit. `signal` aborts when the wait
   * is over: the box must close then (its promise may resolve too; that is ignored). Optional: without it there is no cancel.
   */
  progress?(dialog: ProgressDialog, signal: AbortSignal): Promise<'cancel'>;
  /** A hand-over failed: the app stays; the caller shows the window and a notice. */
  failed(orgId: OrgId, text: string): void;
  /** How often hand-overs are looked at, and when to give up on them (defaults: 250 ms, 10 min). */
  pollMs?: number;
  maxWaitMs?: number;
}

/** 'proceed': quit or close now. 'stay': the user cancelled or a hand-over failed. */
export type CloseCheckResult = 'proceed' | 'stay';

/** Chats that would lose work: open with work that was not handed over, or in the middle of a hand-over. */
export function pendingChats(chats: ChatRef[]): ChatRef[] {
  return chats.filter((c) => (c.tab.status === 'open' && (c.tab.pendingWork || !!c.busy)) || c.tab.status === 'handing-over');
}

export function closeDialogFor(pending: ChatRef[]): CloseDialog {
  const orgs = new Set(pending.map((c) => c.orgId));
  const many = orgs.size > 1;
  const lines = pending
    .map((c) => {
      const chat = t('quit.chatLine', { persona: c.tab.persona, role: c.tab.role });
      return many ? t('quit.chatLineOrg', { chat, org: c.orgName }) : chat;
    })
    .join('\n');
  const notes = many ? t('quit.notesStayMany') : t('quit.notesStay', { cosName: pending[0].cosName });
  return {
    message: t('quit.message'),
    detail: `${t('quit.detail')} ${notes}\n${lines}`,
    buttons: [many ? t('quit.handOverMany') : t('quit.handOver', { cosName: pending[0].cosName }), t('quit.withoutHandover'), t('quit.cancel')],
    defaultId: 0,
    cancelId: 2,
  };
}

export function progressDialogFor(pending: ChatRef[]): ProgressDialog {
  const many = new Set(pending.map((c) => c.orgId)).size > 1;
  return {
    message: t('quit.progressMessage'),
    detail: many ? t('quit.progressDetailMany') : t('quit.progressDetail', { cosName: pending[0].cosName }),
    cancel: t('quit.progressCancel'),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Open chats that already have a note of their own: the quit closes them quietly, and the note stays in inbox/ for the next session. */
function notedChats(chats: ChatRef[]): ChatRef[] {
  return chats.filter((c) => c.tab.status === 'open' && !!c.tab.notePath);
}

export async function closeCheck(d: CloseCheckDeps): Promise<CloseCheckResult> {
  const all = d.chats();
  const pending = pendingChats(all);
  // Chats that already have a note are closed WITHOUT passing it: a CoS turn started now would be killed mid-turn at shutdown.
  // The note stays in inbox/, where the chief of staff finds it at the next session start. Same under every choice.
  const closeNoted = async () => {
    for (const c of notedChats(d.chats())) {
      try {
        await d.closeQuiet(c.orgId, c.tab.tabId);
      } catch {
        // already closed or handing over: the app quits anyway, processes are stopped at shutdown
      }
    }
  };
  if (pending.length === 0) {
    await closeNoted();
    return 'proceed';
  }
  const choice = await d.ask(closeDialogFor(pending));
  if (choice === 1) {
    for (const c of pending) {
      if (c.tab.status !== 'open') continue;
      try {
        await d.closeQuiet(c.orgId, c.tab.tabId);
      } catch {
        // already closed or handing over: the app quits anyway, processes are stopped at shutdown
      }
    }
    await closeNoted();
    return 'proceed';
  }
  if (choice !== 0) return 'stay';

  const fail = (c: ChatRef) => {
    d.failed(c.orgId, t('quit.handoverFailed', { org: c.orgName, persona: c.tab.persona }));
    return 'stay' as const;
  };
  for (const c of pending) {
    if (c.tab.status !== 'open') continue;
    try {
      await d.handOver(c.orgId, c.tab.tabId);
    } catch {
      return fail(c);
    }
  }
  // The wait shows a progress box with a cancel button. Cancelling only stops the wait: the hand-overs already running go on.
  let cancelled = false;
  const ctl = new AbortController();
  void d
    .progress?.(progressDialogFor(pending), ctl.signal)
    .then(() => {
      cancelled = true;
    })
    .catch(() => undefined);
  const poll = d.pollMs ?? 250;
  const deadline = Date.now() + (d.maxWaitMs ?? 10 * 60_000);
  try {
    for (;;) {
      if (cancelled) return 'stay';
      const now = d.chats();
      let waiting = false;
      for (const c of pending) {
        const cur = now.find((x) => x.orgId === c.orgId && x.tab.tabId === c.tab.tabId);
        const status = cur?.tab.status ?? 'closed';
        if (status === 'open') return fail(c);
        if (status === 'handing-over') waiting = true;
      }
      if (!waiting) break;
      if (Date.now() > deadline) return fail(pending.find((c) => now.find((x) => x.tab.tabId === c.tab.tabId)?.tab.status === 'handing-over') ?? pending[0]);
      await sleep(poll);
    }
  } finally {
    ctl.abort();
  }
  if (cancelled) return 'stay';
  await closeNoted();
  return 'proceed';
}

/** closeCheck that never throws: a bug or a failing dialog must not make the app impossible to quit, so an error means proceed. */
export async function safeCloseCheck(d: CloseCheckDeps, log: (...a: unknown[]) => void = console.error): Promise<CloseCheckResult> {
  try {
    return await closeCheck(d);
  } catch (e) {
    log('close check failed, quitting anyway', e);
    return 'proceed';
  }
}
