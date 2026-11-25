import type { EffortLevel, PermissionMode } from '../../shared/types';

export interface ClaudeArgsOptions {
  permissionMode: PermissionMode;
  mcpConfigJson: string;
  /** JSON for `--settings` (`{"deniedMcpServers": [...]}`, see forbidden-connectors.ts), only when set. */
  settingsJson?: string | null;
  /** The "MCP lock": `--strict-mcp-config`, so only the app's own `--mcp-config` server starts (the permission prompt tool still works). */
  strictMcp?: boolean;
  resumeSessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  /** Reasoning effort, always passed. */
  effort: EffortLevel;
  pluginDir?: string | null;
  allowedTools: string[];
  /** Rules Claude Code must refuse (from the hq's permissions.deny). */
  disallowedTools?: string[];
}

/** Arguments for one long-lived headless claude process (stream-json in and out). */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    o.permissionMode,
    '--permission-prompt-tool',
    'mcp__coa__permission_prompt',
    '--mcp-config',
    o.mcpConfigJson,
  ];
  // `--mcp-config` is variadic: an option always follows it (`--strict-mcp-config` or `--setting-sources`). Without the lock there is
  // no `--strict-mcp-config`: the chat loads the servers Claude Code loads in the hq folder, and the deny rules and
  // `deniedMcpServers` limit them.
  if (o.strictMcp) args.push('--strict-mcp-config');
  args.push('--setting-sources', 'project,local');
  if (o.settingsJson) args.push('--settings', o.settingsJson);
  // Both flags are variadic: each rule is its own argument (rules can hold commas and spaces), and a `--` option always follows.
  if (o.allowedTools.length > 0) args.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools && o.disallowedTools.length > 0) args.push('--disallowedTools', ...o.disallowedTools);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  if (o.agent) args.push('--agent', o.agent);
  if (o.model) args.push('--model', o.model);
  // Single-value flag, always pushed after the variadic --allowedTools/--disallowedTools (a `--` option follows them).
  args.push('--effort', o.effort);
  if (o.pluginDir) args.push('--plugin-dir', o.pluginDir);
  return args;
}
