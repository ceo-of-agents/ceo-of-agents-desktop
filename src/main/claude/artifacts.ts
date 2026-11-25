import { ARTIFACT_ENV } from '../config';

const DISABLE_ENV = 'CLAUDE_CODE_DISABLE_ARTIFACT';

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Truthy as Claude Code reads a switch: non-empty and not "0" or "false" (any case). */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

/**
 * The env that turns on Claude Code's artifact tools in `claude -p`: `{ CLAUDE_CODE_ARTIFACT: '1' }`, or `{}` when
 * the user has turned artifacts off or set the variable themselves.
 * - `userSettings`: the parsed user settings file (sessions use `--setting-sources project,local`, so Claude Code never reads it):
 *   `enableArtifact: false` or a truthy `env.CLAUDE_CODE_DISABLE_ARTIFACT` there means off. Missing or malformed: not off.
 * - `env`: the app's own process env. A `CLAUDE_CODE_ARTIFACT` already there passes through `childEnv` untouched and is left as is.
 *   `CLAUDE_CODE_DISABLE_ARTIFACT` there needs no handling: it passes through too and Claude Code honours it.
 * `enableArtifact: false` in the hq's project or local settings is honoured by Claude Code itself.
 */
export function artifactEnv(userSettings: unknown, env: NodeJS.ProcessEnv): Record<string, string> {
  const s = asRecord(userSettings);
  if (s.enableArtifact === false) return {};
  if (truthy(asRecord(s.env)[DISABLE_ENV])) return {};
  if (env[ARTIFACT_ENV] !== undefined) return {};
  return { [ARTIFACT_ENV]: '1' };
}
