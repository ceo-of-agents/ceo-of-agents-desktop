// Confirms before an action that would end work still running: a chief of staff turn in progress or a department
// or worker dispatched in the background (the dispatch registry). Org-scoped actions look only at their own org;
// app-wide ones (quit, shutdown) look at every org. The dialog itself is injected (`ask`), so this has no Electron.
import { formatDuration } from '../../shared/duration';
import { t } from '../../shared/strings';
import type { OrgId } from '../../shared/types';

export interface RunningItem {
  orgId: OrgId;
  orgName: string;
  /** The persona (or agent name) that works; for a chief of staff turn, the chief of staff's name. */
  who: string;
  /** What it works on (a dispatch's description, possibly empty); for a chief of staff turn, a word like "replying". */
  what: string;
  /** ISO time. */
  startedAt: string;
  kind: 'cos-turn' | 'dispatch';
}

/** One org, or every org. */
export type GuardScope = OrgId | 'all';
export type GuardChoice = 'wait' | 'stop' | 'cancel';
export type GuardResult = 'done' | 'queued' | 'cancelled';

export interface ConfirmText {
  message: string;
  detail: string;
}

/**
 * The dialog text: one line per running item ("Max is still working on: Fix it (12 min)"). When the scope is every
 * org and the items come from more than one, each line starts with its org's name and the lines are grouped by org.
 */
export function confirmText(items: RunningItem[], scope: GuardScope, nowMs: number = Date.now()): ConfirmText {
  const orgs = [...new Set(items.map((i) => i.orgId))];
  const grouped = scope === 'all' && orgs.length > 1;
  const ordered = grouped ? orgs.flatMap((id) => items.filter((i) => i.orgId === id)) : items;
  const lines = ordered.map((i) => {
    const time = formatDuration(nowMs - new Date(i.startedAt).getTime());
    if (grouped) return i.what ? t('guard.line.org', { org: i.orgName, who: i.who, what: i.what, time }) : t('guard.line.orgBare', { org: i.orgName, who: i.who, time });
    if (i.kind === 'cos-turn') return t('guard.line.replying', { who: i.who, time });
    return i.what ? t('guard.line.working', { who: i.who, what: i.what, time }) : t('guard.line.workingBare', { who: i.who, time });
  });
  return { message: lines.join('\n'), detail: t('guard.detail') };
}

const CHOICES: GuardChoice[] = ['wait', 'stop', 'cancel'];

/** The dialog's buttons, in order: wait, stop, cancel (the last is also the Escape choice). */
export function guardButtons(): string[] {
  return [t('guard.wait'), t('guard.stop'), t('guard.cancel')];
}

/** The choice behind a button index; anything unexpected is cancel. */
export function choiceAt(index: number): GuardChoice {
  return CHOICES[index] ?? 'cancel';
}

export interface RunGuardDeps {
  /** What runs now in the scope (every org's, for 'all'). */
  items: (scope: GuardScope) => RunningItem[];
  /** Shows the dialog. */
  ask: (text: ConfirmText, scope: GuardScope) => Promise<GuardChoice>;
  /** Stops an org's running work now and writes the "was stopped by" lines in its chief of staff thread. */
  forceStop: (orgId: OrgId, actionLabel: string) => Promise<void>;
  /** Shows that an action waits (a line in the org's chief of staff thread and a notice). */
  notePending: (orgId: OrgId, text: string) => void;
  /** Called for each stopped org once the action has run (a hook for work to do after the stop). */
  afterStop?: (orgId: OrgId) => void;
  now?: () => number;
  /** How long `changed` waits before it looks again, so a queued message that starts right after a turn ends is seen (default 50 ms). */
  settleMs?: number;
}

interface Queued {
  key: string;
  scope: GuardScope;
  label: string;
  fn: () => Promise<void> | void;
  /** Runs alone and drops every other queued action (Quit). */
  wins: boolean;
  /** Put back by `requeue`: the next look (`runReady`) passes over it once, so it waits for the next trigger. */
  skipOnce?: boolean;
}

export interface RunOptions {
  /** Replaces the default "<action> will run when this work has finished." line. */
  pendingText?: string;
  /** What runs when a queued action becomes ready, instead of `fn` (Quit goes through its whole sequence again). */
  whenReady?: () => Promise<void> | void;
  /** When ready, this action runs alone and the rest of the queue is dropped (Quit). */
  wins?: boolean;
}

export class RunGuard {
  private queue: Queued[] = [];
  /** Scopes with a dialog open: a second request for the same scope is dropped, another scope (Quit) still asks. */
  private readonly asking = new Set<GuardScope>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: RunGuardDeps) {}

  /** True when something runs in the scope. */
  hasItems(scope: GuardScope): boolean {
    return this.d.items(scope).length > 0;
  }

  /** Actions waiting for the work to end. */
  pending(): Array<{ scope: GuardScope; label: string }> {
    return this.queue.map((q) => ({ scope: q.scope, label: q.label }));
  }

  /**
   * Runs `fn` at once when nothing runs in the scope. Otherwise asks: wait (queue it until the scope is clear), stop
   * (force-stop the orgs that have work, then run it) or cancel. While a dialog is open, another call is cancelled.
   * Asking again for an action that is already queued lets the user now stop or cancel it. `pendingText` replaces the
   * default "<action> will run when this work has finished." line.
   */
  async run(scope: GuardScope, label: string, fn: () => Promise<void> | void, opts: RunOptions = {}): Promise<GuardResult> {
    if (this.asking.has(scope)) return 'cancelled';
    const key = `${scope}\u0000${label}`;
    const items = this.d.items(scope);
    if (items.length === 0) {
      this.drop(key);
      await fn();
      return 'done';
    }
    this.asking.add(scope);
    let choice: GuardChoice;
    try {
      choice = await this.d.ask(confirmText(items, scope, this.now()), scope);
    } finally {
      this.asking.delete(scope);
    }
    if (choice === 'cancel') {
      this.drop(key);
      return 'cancelled';
    }
    // Work may have ended while the dialog was open.
    const fresh = this.d.items(scope);
    if (choice === 'stop' && fresh.length > 0) {
      this.drop(key);
      const orgs = [...new Set(fresh.map((i) => i.orgId))];
      for (const id of orgs) await this.d.forceStop(id, label);
      await fn();
      for (const id of orgs) this.d.afterStop?.(id);
      return 'done';
    }
    if (fresh.length === 0) {
      this.drop(key);
      await fn();
      return 'done';
    }
    const already = this.queue.some((q) => q.key === key);
    this.drop(key);
    this.queue.push({ key, scope, label, fn: opts.whenReady ?? fn, wins: !!opts.wins });
    if (!already) {
      const text = opts.pendingText ?? t('guard.pending', { action: label });
      for (const id of new Set(fresh.map((i) => i.orgId))) this.d.notePending(id, text);
    }
    return 'queued';
  }

  /** Call whenever a dispatch or a chief of staff thread's busy state changes in any org. */
  changed(): void {
    if (this.queue.length === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runReady();
    }, this.d.settleMs ?? 50);
    this.timer.unref?.();
  }

  /**
   * Puts back a queued action that became ready while it could not run (Quit, while another quit request had a dialog
   * open that was then cancelled). No pending line (it was shown when it was first queued); the next look passes over it,
   * so it runs at the trigger after that, not right after the Cancel.
   */
  requeue(scope: GuardScope, label: string, fn: () => Promise<void> | void, opts: { wins?: boolean } = {}): void {
    const key = `${scope}\u0000${label}`;
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, scope, label, fn, wins: !!opts.wins, skipOnce: true });
  }

  /** Runs every queued action whose scope has no work left (each once). */
  runReady(): void {
    const skipped = new Set(this.queue.filter((q) => q.skipOnce));
    for (const q of skipped) q.skipOnce = false;
    let ready = this.queue.filter((q) => !skipped.has(q) && this.d.items(q.scope).length === 0);
    if (ready.length === 0) return;
    const winner = ready.find((q) => q.wins);
    if (winner) {
      // Quit goes first and alone. The others stay queued: Quit drops them only once it really ends the app (`dropAll`),
      // so a Quit cancelled at its own dialog leaves them waiting.
      ready = [winner];
    }
    this.queue = this.queue.filter((q) => !ready.includes(q));
    const seen = new Set<string>();
    for (const q of ready) {
      if (seen.has(q.key)) continue;
      seen.add(q.key);
      void (async () => {
        try {
          await q.fn();
        } catch (e) {
          console.error('queued action failed', q.label, e);
        }
      })();
    }
  }

  /** Forgets every queued action (the app is ending). */
  dropAll(): void {
    this.queue = [];
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private drop(key: string): void {
    this.queue = this.queue.filter((q) => q.key !== key);
  }
}
