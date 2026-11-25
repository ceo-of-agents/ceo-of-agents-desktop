// The reasoning effort a department's agent file asks for (`effort:` in the frontmatter of `.claude/agents/<agent>.md`, as Claude Code reads it).
import { EFFORTS } from '../settings';
import type { EffortLevel } from '../../shared/types';
import { readAgentFile } from './connectors';
import { parseFrontmatter } from './org-chart';

/** Pure: the effort a frontmatter value names (low, medium, high, xhigh or max), or null for anything else. */
export function parseEffort(value: unknown): EffortLevel | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : null;
}

/** The effort in the frontmatter of the agent file's text, or null (none, invalid, no frontmatter). */
export function effortOfAgentText(text: string): EffortLevel | null {
  return parseEffort(parseFrontmatter(text).data.effort);
}

/** The effort of `agent`'s file in the hq (a plain file inside `.claude/agents/`, under the size cap), or null. Never throws. */
export function agentEffort(hqPath: string, agent: string): EffortLevel | null {
  try {
    const text = readAgentFile(hqPath, agent, { plainOnly: true });
    return text === null ? null : effortOfAgentText(text);
  } catch {
    return null;
  }
}
