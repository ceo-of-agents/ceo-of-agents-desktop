import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ASK_USER_QUESTION, parseQuestions } from '../../shared/questions';
import { t } from '../../shared/strings';
import type { PermissionDecision } from '../../shared/types';
import { updateHqLocalSettings } from './local-settings';
import { artifactSummary } from './artifact-actions';
import { EDIT_TOOLS, editPath, isDenied, readHqPermissionRules, relPath, ruleFor, validateRule } from './rules';

export { ruleFor };

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** One line for the permission card. */
export function summarize(toolName: string, input: unknown, cwd: string): string {
  const i = asObj(input);
  if (toolName === ASK_USER_QUESTION) {
    const qs = parseQuestions(input);
    if (qs) {
      const first = qs[0].question.replace(/\s+/g, ' ').trim();
      return (first.length > 200 ? `${first.slice(0, 199).trimEnd()}…` : first) + (qs.length > 1 ? t('permission.question.more', { count: qs.length - 1 }) : '');
    }
  }
  if (toolName === 'Bash' && str(i.command)) return `Run: ${str(i.command)}`;
  if (toolName === 'Skill' && (str(i.skill) ?? str(i.name))) return `Use skill ${str(i.skill) ?? str(i.name)}`;
  if (toolName === 'WebFetch' && str(i.url)) return `Fetch ${str(i.url)}`;
  if (toolName === 'Artifact') return artifactSummary(input);
  if (EDIT_TOOLS.has(toolName)) {
    const p = editPath(i);
    if (p) return `${toolName} ${relPath(p, cwd)}`;
  }
  let json = '';
  try {
    json = JSON.stringify(input) ?? '';
  } catch {
    json = '';
  }
  if (json.length > 120) json = json.slice(0, 119) + '…';
  return json && json !== '{}' && json !== 'null' ? `${toolName} ${json}` : toolName;
}

/** Adds an allow rule to <hq>/.claude/settings.local.json, keeping every other key. */
export function addAlwaysAllowRule(hqPath: string, rule: string): void {
  updateHqLocalSettings(hqPath, (data) => {
    const perms = asObj(data.permissions);
    const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
    if (allow.includes(rule)) return false;
    perms.allow = [...allow, rule];
    data.permissions = perms;
    return true;
  });
}

export function defaultSocketPath(): string {
  return path.join(os.tmpdir(), `coa-perm-${process.pid}.sock`);
}

export interface RegisterOptions {
  serverScript: string;
  nodePath: string;
  cwd: string;
  /** No "Always allow" proposal for this thread's requests (rule ''): the setup wizard must leave no settings.local.json behind. */
  noRule?: boolean;
}

export interface BrokerRequest {
  requestId: string;
  threadKey: string;
  toolName: string;
  input: unknown;
  summary: string;
  rule: string;
}

interface Pending extends BrokerRequest {
  cwd: string;
  reply: (decision: Obj) => void;
}

const DENY_MESSAGE = 'The user denied this in the app.';
const QUESTION_DENY_MESSAGE = 'The user chose not to answer the questions.';
const CANCEL_MESSAGE = 'The app cancelled this request to apply new settings. Ask again if it is still needed.';

export interface BrokerOptions {
  /** Deny rules from the user's own Claude Code settings (the sessions do not load that file). */
  userDeny?: () => string[];
}

export class PermissionBroker extends EventEmitter {
  private server: net.Server | null = null;
  private socketPath = '';
  private threads = new Map<string, { token: string; cwd: string; noRule: boolean }>();
  private tokens = new Map<string, string>(); // token -> threadKey
  /** Requests approved with "Always allow" in this run, by cwd. Only an exact repeat (same tool, deep-equal input) skips the prompt. */
  private approved = new Map<string, Array<{ toolName: string; input: unknown; rule: string }>>();
  private pendingById = new Map<string, Pending>();
  private sockets = new Set<net.Socket>();

  constructor(private readonly opts: BrokerOptions = {}) {
    super();
  }

  start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // no stale file
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.onConnection(sock));
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          // best effort
        }
        this.server = server;
        resolve();
      });
    });
  }

  register(threadKey: string, opts: RegisterOptions): string {
    const old = this.threads.get(threadKey);
    if (old) this.tokens.delete(old.token);
    const token = randomBytes(24).toString('hex');
    this.threads.set(threadKey, { token, cwd: opts.cwd, noRule: !!opts.noRule });
    this.tokens.set(token, threadKey);
    return JSON.stringify({
      mcpServers: {
        coa: {
          command: opts.nodePath,
          args: [opts.serverScript],
          env: { ELECTRON_RUN_AS_NODE: '1', COA_PERM_SOCKET: this.socketPath, COA_PERM_TOKEN: token },
        },
      },
    });
  }

  unregister(threadKey: string): void {
    const t = this.threads.get(threadKey);
    if (t) this.tokens.delete(t.token);
    this.threads.delete(threadKey);
    for (const p of [...this.pendingById.values()]) {
      if (p.threadKey !== threadKey) continue;
      this.pendingById.delete(p.requestId);
      p.reply({ behavior: 'deny', message: DENY_MESSAGE });
      this.emit('resolved', p.requestId);
    }
  }

  /** Denies and resolves the pending requests of a thread without unregistering it (for example before a restart). Returns how many. */
  denyPending(threadKey: string): number {
    let n = 0;
    for (const p of [...this.pendingById.values()]) {
      if (p.threadKey !== threadKey) continue;
      this.pendingById.delete(p.requestId);
      p.reply({ behavior: 'deny', message: CANCEL_MESSAGE });
      this.emit('resolved', p.requestId);
      n++;
    }
    return n;
  }

  /**
   * Forgets the requests remembered as always-allowed in this run for the hq at `cwd` that were approved under `rule`
   * (the rule was removed from settings.local.json, so an exact repeat must ask again). Returns how many.
   */
  forgetRule(cwd: string, rule: string): number {
    const list = this.approved.get(cwd);
    if (!list) return 0;
    const kept = list.filter((a) => a.rule !== rule);
    if (kept.length) this.approved.set(cwd, kept);
    else this.approved.delete(cwd);
    return list.length - kept.length;
  }

  pending(threadKey: string): BrokerRequest[] {
    return [...this.pendingById.values()]
      .filter((p) => p.threadKey === threadKey)
      .map(({ requestId, threadKey: k, toolName, input, summary, rule }) => ({ requestId, threadKey: k, toolName, input, summary, rule }));
  }

  /**
   * Allow once, Always allow or Deny a pending request. Returns false when nothing was sent: no such request, or Allow on an
   * AskUserQuestion request the app can show as a card (that would send no answers: use `answer`). Deny on a question sends a
   * question-specific message. On a question the app cannot parse (fallback permission card), every decision denies with a
   * message asking Claude to ask again in plain text.
   */
  respond(requestId: string, decision: PermissionDecision, editedRule?: string): boolean {
    const p = this.pendingById.get(requestId);
    if (!p) return false;
    const isQuestion = p.toolName === ASK_USER_QUESTION;
    // A question the app can show as a card is answered with `answer`: Allow would send no answers.
    const readable = isQuestion && parseQuestions(p.input) !== null;
    if (readable && decision !== 'deny') return false;
    this.pendingById.delete(requestId);
    if (isQuestion && !readable) {
      // The card could not be built (the normal permission card is the fallback): any button sends the same way out, so
      // Allow never does nothing. Claude is told to ask in plain text. Still never auto-answered, no timeout.
      p.reply({ behavior: 'deny', message: t('permission.question.unreadable') });
    } else if (decision === 'deny') {
      p.reply({ behavior: 'deny', message: isQuestion ? QUESTION_DENY_MESSAGE : DENY_MESSAGE });
    } else {
      // "Always allow" needs a safe proposal; without one (or with an unsafe edit) it is an Allow once.
      if (decision === 'always' && p.rule) {
        const rule = validateRule(editedRule, p.toolName, p.cwd) ? editedRule.trim() : p.rule;
        try {
          addAlwaysAllowRule(p.cwd, rule);
        } catch {
          // the exact repeat below still applies for this run
        }
        let list = this.approved.get(p.cwd);
        if (!list) this.approved.set(p.cwd, (list = []));
        list.push({ toolName: p.toolName, input: p.input, rule });
      }
      p.reply({ behavior: 'allow', updatedInput: p.input });
    }
    this.emit('resolved', requestId);
    return true;
  }

  /**
   * Answers a pending AskUserQuestion request: one non-empty string per question, keyed by the question text, no other keys.
   * Returns false, and replies nothing, for any other request or an answer that does not fit the questions.
   */
  answer(requestId: string, answers: Record<string, string>): boolean {
    const p = this.pendingById.get(requestId);
    if (!p || p.toolName !== ASK_USER_QUESTION) return false;
    const questions = parseQuestions(p.input);
    if (!questions || typeof answers !== 'object' || answers === null || Array.isArray(answers)) return false;
    const keys = Object.keys(answers);
    if (keys.length !== questions.length || !questions.every((q) => Object.prototype.hasOwnProperty.call(answers, q.question))) return false;
    const clean: Array<[string, string]> = [];
    for (const q of questions) {
      const v = answers[q.question];
      if (typeof v !== 'string' || !v.trim()) return false;
      clean.push([q.question, v]);
    }
    this.pendingById.delete(requestId);
    p.reply({ behavior: 'allow', updatedInput: { ...asObj(p.input), answers: Object.fromEntries(clean) } });
    this.emit('resolved', requestId);
    return true;
  }

  async stop(): Promise<void> {
    for (const p of [...this.pendingById.values()]) {
      p.reply({ behavior: 'deny', message: DENY_MESSAGE });
      this.emit('resolved', p.requestId);
    }
    this.pendingById.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
  }

  private onConnection(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onLine(sock, line);
      }
    });
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => this.sockets.delete(sock));
  }

  private onLine(sock: net.Socket, line: string): void {
    const reply = (d: Obj) => {
      if (!sock.destroyed) sock.write(JSON.stringify(d) + '\n');
    };
    let msg: Obj;
    try {
      msg = asObj(JSON.parse(line));
    } catch {
      reply({ behavior: 'deny', message: 'Malformed request.' });
      return;
    }
    const token = str(msg.token);
    const threadKey = token ? this.tokens.get(token) : undefined;
    const thread = threadKey ? this.threads.get(threadKey) : undefined;
    if (!token || !threadKey || !thread) {
      reply({ behavior: 'deny', message: 'Unknown session.' });
      return;
    }
    const toolName = str(msg.tool_name) ?? 'unknown';
    const input = msg.input ?? {};
    const rule = thread.noRule ? '' : ruleFor(toolName, input, thread.cwd);
    // Deny rules always win. Read on each request (the files are small) so a rule added in a terminal applies at once.
    const denyRules = [...readHqPermissionRules(thread.cwd).deny, ...(this.opts.userDeny?.() ?? [])];
    const denied = isDenied(denyRules, toolName, input, thread.cwd);
    if (denied) {
      reply({ behavior: 'deny', message: `Blocked by the deny rule ${denied}.` });
      return;
    }
    // Claude Code only asks for what its own rules do not allow. The one thing allowed here without a prompt is an
    // exact repeat of a request the user already approved with "Always allow" in this run.
    // A question is never auto-allowed: allowing it without answers tells the model the user did not answer.
    if (toolName !== ASK_USER_QUESTION && (this.approved.get(thread.cwd) ?? []).some((a) => a.toolName === toolName && isDeepStrictEqual(a.input, input))) {
      reply({ behavior: 'allow', updatedInput: input });
      return;
    }
    const requestId = randomUUID();
    const summary = summarize(toolName, input, thread.cwd);
    this.pendingById.set(requestId, { requestId, threadKey, toolName, input, summary, rule, cwd: thread.cwd, reply });
    this.emit('request', { requestId, threadKey, toolName, input, summary, rule } satisfies BrokerRequest);
  }
}
