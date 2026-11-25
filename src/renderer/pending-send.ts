// The undo window of a waiting item (5.9): Approve, Decline, Done and an option do not send at once. They wait 4 s,
// during which the card says "Approving…" with an Undo; then the message goes to the chief of staff.
// The timers live here, outside any component and keyed by org and item code: the card can unmount (another org
// selected, the panel hidden) and the message is still sent, because the user chose it. Another org never sees
// this org's state.

export const UNDO_MS = 4000;
/** After sending, how long to wait for the chief of staff's turn to start before giving up on the "Sent" state. */
export const SENT_GRACE_MS = 10_000;

export type PendingKind = 'approve' | 'decline' | 'done' | 'option';
export type PendingStage = 'undo' | 'sent';

export interface Pending {
  orgId: string;
  code: string;
  kind: PendingKind;
  /** The option letter, for kind 'option'. */
  optionKey?: string;
  stage: PendingStage;
  startedAt: number;
  /** When the message was handed to the app to send (ms). Only a chief of staff turn that started at or after this counts. */
  sentAt?: number;
  /** After sending: a chief of staff turn that started after the send has been seen running. */
  sawBusy: boolean;
}

const keyOf = (orgId: string, code: string): string => `${orgId}|${code}`;

export function createPendingStore(opts: { undoMs?: number; graceMs?: number } = {}) {
  const undoMs = opts.undoMs ?? UNDO_MS;
  const graceMs = opts.graceMs ?? SENT_GRACE_MS;
  const entries = new Map<string, Pending>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  /** Last known busy state of each org's chief of staff, from observe. */
  const orgBusy = new Map<string, boolean>();
  let version = 0;
  const emit = () => {
    version++;
    listeners.forEach((l) => l());
  };
  const stopTimer = (k: string) => {
    const h = timers.get(k);
    if (h) clearTimeout(h);
    timers.delete(k);
  };
  const remove = (k: string) => {
    stopTimer(k);
    if (entries.delete(k)) emit();
  };

  return {
    /** Starts the undo window. `send` runs once, after `undoMs`, unless undone; a failed send clears the state. False if one is already running. */
    start(orgId: string, code: string, kind: PendingKind, optionKey: string | undefined, send: () => Promise<unknown> | void): boolean {
      const k = keyOf(orgId, code);
      if (entries.has(k)) return false;
      entries.set(k, { orgId, code, kind, optionKey, stage: 'undo', startedAt: Date.now(), sawBusy: false });
      timers.set(k, setTimeout(() => {
        timers.delete(k);
        const cur = entries.get(k);
        if (!cur || cur.stage !== 'undo') return;
        const sentAt = Date.now();
        entries.set(k, { ...cur, stage: 'sent', startedAt: sentAt, sentAt });
        // Give up on "Sent" when no turn starts within the grace time. While the chief of staff is still busy with an
        // earlier turn, the message is behind it: keep waiting, or the buttons would come back and a second
        // click would send the same answer twice.
        const grace = () => {
          timers.set(k, setTimeout(() => {
            timers.delete(k);
            const e = entries.get(k);
            if (!e || e.sawBusy) return;
            if (orgBusy.get(orgId)) grace();
            else remove(k);
          }, graceMs));
        };
        grace();
        emit();
        try {
          Promise.resolve(send()).catch(() => remove(k));
        } catch {
          remove(k);
        }
      }, undoMs));
      emit();
      return true;
    },
    /** Cancels a message still in its undo window. False when it was already sent. */
    undo(orgId: string, code: string): boolean {
      const k = keyOf(orgId, code);
      if (entries.get(k)?.stage !== 'undo') return false;
      remove(k);
      return true;
    },
    get: (orgId: string, code: string): Pending | undefined => entries.get(keyOf(orgId, code)),
    /** Every pending item of an org (undo window or sent), oldest start first. */
    list: (orgId: string): Pending[] => [...entries.values()].filter((e) => e.orgId === orgId).sort((a, b) => a.startedAt - b.startedAt),
    /**
     * Tells the store what the org's panel shows now. A sent item that left the list is done. One still there when the
     * chief of staff's turn has ended goes back to normal (the chief of staff will have said why in the thread).
     * `turnStartedAt` is when the chief of staff's current turn started (ms), null when idle: a turn that started
     * before the send is an earlier one (the message is behind it) and does not count.
     */
    observe(orgId: string, busy: boolean, presentCodes: ReadonlySet<string>, turnStartedAt: number | null): void {
      orgBusy.set(orgId, busy);
      for (const [k, e] of [...entries]) {
        if (e.orgId !== orgId || e.stage !== 'sent') continue;
        const ours = busy && turnStartedAt !== null && e.sentAt !== undefined && turnStartedAt >= e.sentAt;
        if (!presentCodes.has(e.code)) remove(k);
        else if (ours && !e.sawBusy) {
          entries.set(k, { ...e, sawBusy: true });
          emit();
        } else if (!busy && e.sawBusy) remove(k);
      }
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    version: (): number => version,
    /** For tests and teardown. */
    clear(): void {
      for (const k of [...timers.keys()]) stopTimer(k);
      entries.clear();
      orgBusy.clear();
      emit();
    },
  };
}

export type PendingStore = ReturnType<typeof createPendingStore>;

/** The one store of the app. */
export const pendingStore: PendingStore = createPendingStore();
