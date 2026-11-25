// MCP stdio server that Claude Code launches for --permission-prompt-tool.
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and forwards each tool call to the app over a unix socket.
// stdout carries JSON-RPC only; logs go to stderr.
import net from 'node:net';

type Obj = Record<string, unknown>;
export type Forward = (args: { tool_name: string; input: unknown; tool_use_id?: string }) => Promise<object>;

const TOOL = {
  name: 'permission_prompt',
  description: 'Ask the user in the app whether Claude may use a tool.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure message handler: returns the JSON-RPC response, or null when none is due. */
export async function handleMessage(msg: unknown, forward: Forward): Promise<object | null> {
  if (!isObj(msg)) return null;
  const id = msg.id;
  const hasId = typeof id === 'number' || typeof id === 'string';
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (!hasId) return null; // notifications and stray responses
  const ok = (result: object) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const params = isObj(msg.params) ? msg.params : {};
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'coa', version: '0.1.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [TOOL] });
    case 'tools/call': {
      const args = isObj(params.arguments) ? params.arguments : {};
      let decision: object;
      try {
        decision = await forward({
          tool_name: typeof args.tool_name === 'string' ? args.tool_name : 'unknown',
          input: args.input ?? {},
          tool_use_id: typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined,
        });
      } catch (e) {
        decision = { behavior: 'deny', message: `Could not reach the app to ask for permission: ${e instanceof Error ? e.message : String(e)}` };
      }
      return ok({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

/** Sends one request line to the app's socket and waits for one reply line. */
export function forwardToSocket(socketPath: string, token: string): Forward {
  return (args) =>
    new Promise<object>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      let buf = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        fn();
      };
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify({ token, ...args }) + '\n'));
      sock.on('data', (c: string) => {
        buf += c;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        try {
          const v: unknown = JSON.parse(buf.slice(0, i));
          finish(() => (isObj(v) ? resolve(v) : reject(new Error('bad reply'))));
        } catch {
          finish(() => reject(new Error('bad reply')));
        }
      });
      sock.on('error', (e) => finish(() => reject(e)));
      sock.on('close', () => finish(() => reject(new Error('connection closed'))));
    });
}

function main(): void {
  const socketPath = process.env.COA_PERM_SOCKET || '';
  const token = process.env.COA_PERM_TOKEN || '';
  const forward = forwardToSocket(socketPath, token);
  let buf = '';
  const out = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');
  const onLine = (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write('permission-server: ignoring non-JSON line\n');
      return;
    }
    handleMessage(msg, forward).then(
      (res) => {
        if (res) out(res);
      },
      (e) => process.stderr.write(`permission-server: ${String(e)}\n`),
    );
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (typeof require !== 'undefined' && require.main === module) main();
