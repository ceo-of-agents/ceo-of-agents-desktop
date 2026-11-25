import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { SignInState } from '../../shared/types';
import { childEnv, run, spawnProcess, type Runner, type Spawner } from './exec';
import { checkSignedIn } from './prereqs';
import { t } from '../../shared/strings';

export interface SignInOptions {
  runner?: Runner;
  spawner?: Spawner;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  timeoutMs?: number;
  exitGraceMs?: number;
}

const URL_RE = /https:\/\/[^\s"'<>]+/;

/**
 * Runs `claude auth login` and polls `auth status` until signed in.
 * Never writes to the login process: stdin is ignored. Only the first https URL is kept.
 */
export class SignInFlow extends EventEmitter {
  private state: SignInState = { running: false, url: null, error: null };
  private child: ChildProcess | null = null;
  private poll: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private grace: NodeJS.Timeout | null = null;
  private checking = false;
  private runId = 0;

  constructor(private readonly opts: SignInOptions = {}) {
    super();
  }

  getState(): SignInState {
    return { ...this.state };
  }

  start(claudePath: string): void {
    if (this.state.running) return;
    this.cleanup();
    const id = ++this.runId;
    const runner = this.opts.runner ?? run;
    const spawner = this.opts.spawner ?? spawnProcess;
    this.setState({ running: true, url: null, error: null });

    let child: ChildProcess;
    try {
      child = spawner(claudePath, ['auth', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], env: this.opts.env ?? childEnv() });
    } catch {
      this.finish(id, t('signin.err.start'));
      return;
    }
    this.child = child;
    const onData = (buf: Buffer | string): void => {
      if (this.state.url) return;
      const m = URL_RE.exec(String(buf));
      if (m) this.setState({ ...this.state, url: m[0] });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => {
      if (id === this.runId && this.state.running) this.finish(id, t('signin.err.start'));
    });
    child.on('exit', () => {
      if (id !== this.runId || !this.state.running) return;
      this.grace = setTimeout(() => this.finish(id, t('signin.err.notFinished')), this.opts.exitGraceMs ?? 30000);
    });

    const check = async (): Promise<void> => {
      if (this.checking || id !== this.runId || !this.state.running) return;
      this.checking = true;
      try {
        const ok = await checkSignedIn(claudePath, runner);
        if (ok && id === this.runId && this.state.running) this.finish(id, null);
      } finally {
        this.checking = false;
      }
    };
    this.poll = setInterval(() => void check(), this.opts.pollMs ?? 3000);
    this.deadline = setTimeout(() => this.finish(id, t('signin.err.timeout')), this.opts.timeoutMs ?? 600000);
  }

  cancel(): void {
    if (!this.state.running) return;
    this.runId++;
    this.cleanup();
    this.setState({ running: false, url: null, error: null });
    this.emit('done');
  }

  private finish(id: number, error: string | null): void {
    if (id !== this.runId) return;
    this.cleanup();
    this.setState({ running: false, url: error ? this.state.url : null, error });
    this.emit('done');
  }

  private cleanup(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.deadline) clearTimeout(this.deadline);
    if (this.grace) clearTimeout(this.grace);
    this.poll = this.deadline = this.grace = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }

  private setState(s: SignInState): void {
    this.state = s;
    this.emit('state', { ...s });
  }
}
