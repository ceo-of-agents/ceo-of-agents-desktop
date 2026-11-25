import { parseRateLimitInfo, type RateLimitInfo } from '../../shared/usage';

/** One entry of the `mcp_servers` list of an init message. */
export interface McpServerInfo {
  name: string;
  /** `pending` (first init of a process), `connected`, `failed`, `needs-auth`, ... ; `unknown` when absent. */
  status: string;
  /** The config scope (`project`, `local`, `user`, `claudeai`, `dynamic`, `plugin`, ...), null when absent. */
  source: string | null;
}

const MCP_TEXT_MAX = 200;
const MCP_SERVERS_MAX = 200;

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; /** The resolved model id Claude Code runs on (`model` of the init message), null when absent. */ model: string | null; /** Names of the MCP servers that failed to start (`mcp_servers` with status `failed`), empty when none. */ mcpFailed: string[]; /** Every server of the init message's `mcp_servers` (the app's own `coa` included), cleaned and capped. */ mcpServers: McpServerInfo[] }
  | { kind: 'text-delta'; text: string }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  /** The result of a tool call arrived (a tool_result block in a user message). `async`: the Agent call only launched a background task. */
  | { kind: 'tool-result'; id: string; isError: boolean; async: boolean }
  /** `numTurns`: the result's `num_turns` (null when absent); 0 for a turn with no model call (a leftover notice on --resume). */
  | { kind: 'result'; isError: boolean; text: string; sessionId: string | null; numTurns: number | null; /** `api_error_status` (429: a rate limit), only when Claude Code gave one. */ apiErrorStatus?: number; /** The context size after the turn's last model call (see `contextOf`), null when Claude Code gave none. */ contextTokens: number | null }
  /** Plan usage after a model call (`rate_limit_event`; only the windows are read). */
  | { kind: 'rate-limit'; info: RateLimitInfo }
  /**
   * Where a message written on stdin is (`command_lifecycle`, Claude Code 2.1.x; only for a message that carries a
   * `uuid`): `queued`, `started` (the turn that handles it began, or it was absorbed into the running turn), `completed`.
   */
  | { kind: 'command'; uuid: string; state: string }
  /** Any other streaming event of the model (a message starts, thinking): the session is visibly working. */
  | { kind: 'activity' }
  /** A sub-agent message went by (never its content): the agent with this Agent call id is alive. `agentId`: its `agent_id` (a resumed agent's lines still carry the original Agent call id). */
  | { kind: 'sub-activity'; parentToolUseId: string; agentId?: string }
  /** A tool call of a sub-agent (never shown: only the turn's list of what its sub-agents wrote). */
  | { kind: 'sub-tool-use'; parentToolUseId: string; name: string; input: unknown }
  /** A top-level agent task started (`task_started` of type local_agent; nested work is dropped). */
  | { kind: 'task-started'; toolUseId: string; taskId: string; agent: string; description: string; background: boolean }
  | { kind: 'task-progress'; toolUseId: string }
  /** A task reached a final status (`task_notification`, or `task_updated` with a final `patch.status`). `status` is Claude Code's word ("completed", "killed", "stopped", ...). */
  | { kind: 'task-ended'; toolUseId: string | null; taskId: string; status: string; /** From `task_notification` (not `task_updated`). */ notification: boolean; /** The task is a top-level agent seen in `task_started`. */ topLevel: boolean; /** That agent ran in the background (`is_backgrounded`). */ background: boolean };

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Task statuses that are an end (seen on 2.1.327: completed, killed, stopped; the others by name). Any other status is not an end. */
export const FINAL_STATUSES = new Set(['completed', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled']);

/** The text of a tool_result's content (a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/** The names of the servers with status `failed` in the `mcp_servers` list of an init message. */
function failedServers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const names: string[] = [];
  for (const e of v) if (isObj(e) && e.status === 'failed' && typeof e.name === 'string' && e.name.trim() && !names.includes(e.name.trim())) names.push(e.name.trim());
  return names;
}

/** The `mcp_servers` of an init message: entries with a non-empty string name, strings trimmed and cut at 200 characters, at most 200, one per name. Never throws. */
export function mcpServersOf(v: unknown): McpServerInfo[] {
  const out: McpServerInfo[] = [];
  if (!Array.isArray(v)) return out;
  const clean = (x: unknown): string => (typeof x === 'string' ? x.trim().slice(0, MCP_TEXT_MAX) : '');
  for (const e of v) {
    if (out.length >= MCP_SERVERS_MAX) break;
    if (!isObj(e)) continue;
    const name = clean(e.name);
    if (!name || out.some((o) => o.name === name)) continue;
    out.push({ name, status: clean(e.status) || 'unknown', source: clean(e.source) || null });
  }
  return out;
}

/** Input tokens of one model call: what is in the context (new input, cache reads and cache writes). Null when none of the three is a number. */
function callTokens(u: unknown): number | null {
  if (!isObj(u)) return null;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
  if (!parts.some((v) => typeof v === 'number')) return null;
  return parts.reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0);
}

/**
 * The context size a `result` reports, with no extra model call. The result's own `usage` is summed over all model calls
 * of the turn (it overstates the context), but `usage.iterations` holds the last call only (checked with Claude Code
 * 2.1.327), so its last element is read; without it, `fallback` (the usage of the turn's last top-level assistant message).
 */
function contextOf(usage: unknown, fallback: number | null): number | null {
  if (isObj(usage) && Array.isArray(usage.iterations) && usage.iterations.length > 0) {
    const n = callTokens(usage.iterations[usage.iterations.length - 1]);
    if (n !== null) return n;
  }
  return fallback;
}

/** Turns stdout chunks of `claude -p --output-format stream-json` into the few events the app needs. */
export class StreamParser {
  private buf = '';
  /** Task ids of the top-level agents seen in `task_started`. */
  private readonly topTasks = new Map<string, boolean>();
  /** Tokens of the last top-level assistant message since the last result (the fallback of `contextOf`). */
  private lastAssistantTokens: number | null = null;

  feed(chunk: string): ClaudeEvent[] {
    this.buf += chunk;
    const out: ClaudeEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      out.push(...this.parseLine(line));
    }
    return out;
  }

  flush(): ClaudeEvent[] {
    const line = this.buf;
    this.buf = '';
    return this.parseLine(line);
  }

  private parseLine(line: string): ClaudeEvent[] {
    const t = line.trim();
    if (!t.startsWith('{')) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      return [];
    }
    if (!isObj(msg)) return [];
    if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('hook_')) return []; // never read
    // Sub-agent traffic: only a sign of life, never content.
    if (msg.parent_tool_use_id != null) {
      const parent = msg.parent_tool_use_id;
      if (typeof parent !== 'string') return [];
      const out: ClaudeEvent[] = [{ kind: 'sub-activity', parentToolUseId: parent, ...(typeof msg.agent_id === 'string' && msg.agent_id ? { agentId: msg.agent_id } : {}) }];
      const m = msg.type === 'assistant' ? msg.message : null;
      if (isObj(m) && Array.isArray(m.content)) {
        for (const b of m.content) if (isObj(b) && b.type === 'tool_use' && typeof b.name === 'string') out.push({ kind: 'sub-tool-use', parentToolUseId: parent, name: b.name, input: b.input });
      }
      return out;
    }
    switch (msg.type) {
      case 'system':
        return parseSystem(msg, this.topTasks);
      case 'stream_event': {
        const ev = msg.event;
        if (!isObj(ev)) return [];
        if (ev.type === 'content_block_delta' && isObj(ev.delta) && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') return [{ kind: 'text-delta', text: ev.delta.text }];
        return [{ kind: 'activity' }];
      }
      case 'assistant': {
        const m = msg.message;
        if (isObj(m)) {
          const n = callTokens(m.usage);
          if (n !== null) this.lastAssistantTokens = n;
        }
        if (!isObj(m) || !Array.isArray(m.content)) return [];
        const out: ClaudeEvent[] = [];
        for (const b of m.content) {
          if (!isObj(b)) continue;
          if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'assistant-text', text: b.text });
          else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
            out.push({ kind: 'tool-use', id: b.id, name: b.name, input: b.input });
        }
        return out;
      }
      case 'user': {
        // Claude Code sends each tool's result back as a user message: the moment that tool call ended.
        const m = msg.message;
        if (!isObj(m) || !Array.isArray(m.content)) return [];
        const out: ClaudeEvent[] = [];
        for (const b of m.content) {
          if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') out.push({ kind: 'tool-result', id: b.tool_use_id, isError: b.is_error === true, async: resultText(b.content).startsWith('Async agent launched') });
        }
        return out;
      }
      case 'command_lifecycle':
        if (typeof msg.command_uuid === 'string' && typeof msg.state === 'string') return [{ kind: 'command', uuid: msg.command_uuid, state: msg.state }];
        return [];
      case 'result': {
        const contextTokens = contextOf(msg.usage, this.lastAssistantTokens);
        this.lastAssistantTokens = null;
        return [
          {
            kind: 'result',
            isError: msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success'),
            text: typeof msg.result === 'string' ? msg.result : '',
            sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
            numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
            ...(typeof msg.api_error_status === 'number' ? { apiErrorStatus: msg.api_error_status } : {}),
            contextTokens,
          },
        ];
      }
      case 'rate_limit_event': {
        const info = parseRateLimitInfo(msg.rate_limit_info);
        return info ? [{ kind: 'rate-limit', info }] : [];
      }
      default:
        return [];
    }
  }
}

function parseSystem(msg: Json, topTasks: Map<string, boolean>): ClaudeEvent[] {
  switch (msg.subtype) {
    case 'init':
      if (typeof msg.session_id !== 'string') return [];
      return [{ kind: 'init', sessionId: msg.session_id, model: typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : null, mcpFailed: failedServers(msg.mcp_servers), mcpServers: mcpServersOf(msg.mcp_servers) }];
    case 'task_started':
      // Nested work (a sub-agent's shell command, a task owned by another) is not a dispatch.
      if ((msg.task_type !== undefined && msg.task_type !== 'local_agent') || msg.owned_by_subagent === true || msg.parent_task_id != null) return [];
      if (typeof msg.tool_use_id !== 'string' || typeof msg.task_id !== 'string') return [];
      topTasks.set(msg.task_id, msg.is_backgrounded === true);
      return [
        {
          kind: 'task-started',
          toolUseId: msg.tool_use_id,
          taskId: msg.task_id,
          agent: typeof msg.subagent_type === 'string' ? msg.subagent_type : '',
          description: typeof msg.description === 'string' ? msg.description : '',
          background: msg.is_backgrounded === true,
        },
      ];
    case 'task_progress':
      return typeof msg.tool_use_id === 'string' ? [{ kind: 'task-progress', toolUseId: msg.tool_use_id }] : [];
    case 'task_notification': {
      if (typeof msg.status !== 'string' || !FINAL_STATUSES.has(msg.status)) return [];
      const taskId = typeof msg.task_id === 'string' ? msg.task_id : '';
      // Only a top-level agent's notification makes Claude Code start a turn by itself when none is in flight.
      return [{ kind: 'task-ended', toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null, taskId, status: msg.status, notification: true, topLevel: topTasks.has(taskId), background: topTasks.get(taskId) === true }];
    }
    case 'task_updated': {
      const status = isObj(msg.patch) ? msg.patch.status : undefined;
      if (typeof status !== 'string' || !FINAL_STATUSES.has(status) || typeof msg.task_id !== 'string') return [];
      return [{ kind: 'task-ended', toolUseId: null, taskId: msg.task_id, status, notification: false, topLevel: topTasks.has(msg.task_id), background: topTasks.get(msg.task_id) === true }];
    }
    default:
      return []; // everything else is dropped
  }
}
