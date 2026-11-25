// One path for every way the app ends (Cmd+Q, the last window's close button, macOS shutdown): the department chats'
// handover check first, then the run guard, then a single shutdown. Pure of Electron, so it can be tested.
import type { RunGuard } from './org/run-guard';

export interface QuitDeps {
  /** The department chats check (hand over or close quietly). True: go on; false: the user cancelled. */
  handoverCheck: () => Promise<boolean>;
  guard: Pick<RunGuard, 'run' | 'dropAll' | 'changed' | 'requeue'>;
  /** "Quit", and the pending line shown when the user chooses to wait. */
  label: string;
  pendingText: string;
  /** Stops what runs in every org without asking (macOS shutdown), with the "was stopped by" lines. */
  forceStopAll: () => Promise<void>;
  /** Stops the orgs and the broker; called once. */
  shutdown: () => Promise<void>;
  /** Lets the app exit (app.quit once `allowQuit` is true). */
  exit: () => void;
}

export class QuitCoordinator {
  /** A quit request is being checked (handover dialog, run guard dialog) or the shutdown runs. */
  private inProgress = false;
  private finished = false;
  private shuttingDown = false;
  private finishing: Promise<void> | null = null;
  /** The queued Quit became ready while a request was open (see `fromQueue`). */
  private readyWhileOpen = false;

  constructor(private readonly d: QuitDeps) {}

  /** True once the shutdown is done: `before-quit` and window `close` let the app go. */
  get allowQuit(): boolean {
    return this.finished;
  }

  /** The system is going down: no dialog from now on, and a dialog already open does not hold the shutdown back. */
  systemShutdown(): void {
    this.shuttingDown = true;
    if (this.inProgress) void this.shutdownNow();
  }

  /**
   * Cmd+Q or the last window's close button. Cancel at any step leaves the app as it was, and the next request starts
   * from the first step again. "Wait" queues the quit; when the work has ended it goes through the whole sequence again.
   * Resolves true when this request led to the shutdown (or the shutdown was already done or running), false when it was
   * cancelled, queued ("Wait") or is the same quit as a request that is still open.
   */
  async request(): Promise<boolean> {
    // A request while one is open (a second Cmd+Q, or a queued Quit that became ready meanwhile) is that same quit:
    // the open one decides. After a Cancel nothing reopens by itself; the next Cmd+Q starts again.
    if (this.finished || this.finishing) return true;
    if (this.inProgress) return false;
    this.inProgress = true;
    this.readyWhileOpen = false;
    let guarded = false;
    try {
      if (this.shuttingDown) {
        await this.shutdownNow();
        return true;
      }
      let ok = false;
      try {
        ok = await this.d.handoverCheck();
      } catch (err) {
        console.error('handover check failed', err);
      }
      if (!ok || this.finishing) return this.finishing !== null;
      guarded = true;
      await this.d.guard.run('all', this.d.label, () => this.finish(), {
        pendingText: this.d.pendingText,
        wins: true,
        whenReady: () => this.fromQueue(),
      });
    } finally {
      this.inProgress = false;
      // The queued Quit became ready while this request was open and the request ended before the run guard (whose own
      // Cancel or Wait decides about a queued Quit): it stays queued and runs at the next trigger, not right now.
      if (!this.finishing && this.readyWhileOpen && !guarded) this.d.guard.requeue('all', this.d.label, () => this.fromQueue(), { wins: true });
      this.readyWhileOpen = false;
      // A Quit that did not go through leaves the other queued actions to run when their work is done.
      if (!this.finishing) this.d.guard.changed();
    }
    return this.finishing !== null;
  }

  /** A queued Quit is ready: the whole sequence again, or, while a request is open, noted for that request to settle. */
  private async fromQueue(): Promise<void> {
    if (this.inProgress && !this.finishing && !this.finished) {
      this.readyWhileOpen = true;
      return;
    }
    await this.request();
  }

  /** Stops what runs without asking, then ends the app; errors never stop the shutdown. */
  private async shutdownNow(): Promise<void> {
    try {
      await this.d.forceStopAll();
    } catch (err) {
      console.error('force stop failed', err);
    }
    await this.finish();
  }

  private finish(): Promise<void> {
    if (!this.finishing) {
      this.finishing = (async () => {
        this.d.guard.dropAll();
        await this.d.shutdown().catch((err) => console.error('shutdown failed', err));
        this.finished = true;
        this.d.exit();
      })();
    }
    return this.finishing;
  }
}
