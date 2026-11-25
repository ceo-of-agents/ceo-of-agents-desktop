// Fake MCP server used to record the mcp-init-*.jsonl fixtures (Claude Code 2.1.327, 2026-11-18).
// Usage: node fake-mcp-server.mjs <name> [stdio|http] [port]. Tools: ping, send. Not used by the unit tests.
// Recording: an empty CLAUDE_CONFIG_DIR (not signed in, so no claude.ai connector and no model call), a temp project with
// a .mcp.json (example-project stdio, example-remote http, example-forbidden stdio), example-local added with
// `claude mcp add -s local`, and an agent file example-dept with `tools: Read, mcp__example-project__ping`.
// Two user messages through `claude -p --input-format stream-json --output-format stream-json --verbose
// --setting-sources project,local --settings '{"deniedMcpServers":[{"serverName":"example-forbidden"}]}'`, plus
// cos: `--disallowedTools 'mcp__example-forbidden__*' 'mcp__example-l*'`; agent: `--disallowedTools 'mcp__example-forbidden__*' --agent example-dept`.
// Each fixture keeps the two init lines (fields scrubbed to the ones the app reads). example-forbidden never started.
// Later fixtures (same setup, plus example.dotted, a stdio server in the .mcp.json, and an agent file example-notools with no tools: line):
// mcp-init-notools runs `--agent example-notools`; mcp-init-case passes case-mismatched deny rules (`--disallowedTools 'mcp__EXAMPLE-PROJECT__*'
// 'mcp__Example-Local'`); mcp-init-strict-cos and mcp-init-strict-agent add `--strict-mcp-config` and a `--mcp-config` with a server `coa`, without
// and with `--agent example-notools`; mcp-init-denied-sanitized and mcp-init-denied-real pass `deniedMcpServers` with `example_dotted` and `example.dotted`.
// Four more recordings (same setup, strict ones also with `--mcp-config` for `coa`): mcp-init-star runs an agent with `tools: "*"` (every tool, MCP ones
// included; `["*"]` and `Read, *` gave the same, not saved); mcp-init-inline-strict runs `--strict-mcp-config` with an agent with no tools line that declares
// a server in its frontmatter `mcpServers:` (folder trusted: only `coa` starts); mcp-init-plugin-strict and mcp-init-plugin-strict-agent load a local plugin
// with `--plugin-dir` whose root `.mcp.json` declares a server, under `--strict-mcp-config`, without an agent and with an agent with no tools line (only `coa` starts).
import fs from 'node:fs'; import http from 'node:http';
const name = process.argv[2] || 'example'; const mode = process.argv[3] || 'stdio'; const port = Number(process.argv[4] || 0);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${name} started\n`);
const tools = [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} } }, { name: 'send', description: 'Send.', inputSchema: { type: 'object', properties: {} } }];
function handle(m) {
  if (m.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } });
  if (m.method === 'tools/list') return ok({ tools });
  if (m.method === 'tools/call') { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${name} called ${m.params?.name}\n`); return ok({ content: [{ type: 'text', text: 'pong' }] }); }
  if (m.method === 'ping') return ok({});
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } };
}
if (mode === 'http') {
  http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let m; try { m = JSON.parse(b); } catch { res.writeHead(400); return res.end(); }
    const r = Array.isArray(m) ? m.map(handle).filter(Boolean) : handle(m);
    if (!r || (Array.isArray(r) && !r.length)) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); }); }).listen(port, '127.0.0.1');
} else {
  let buf = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const r = handle(JSON.parse(l)); if (r) process.stdout.write(JSON.stringify(r) + '\n'); } });
}
