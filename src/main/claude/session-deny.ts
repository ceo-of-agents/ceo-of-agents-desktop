// The deny rules a chat process gets in `--disallowedTools`: the hq's own, the user's, and the forbidden connectors.
// One pure function, so a process start and the Settings view (no live session) compute the same list.
import { hqMcpServerNames } from '../hq/connectors';
import { forbiddenDenyRules, rawServerNames, readForbiddenPatterns, serversKeptOut } from '../hq/forbidden-connectors';
import { anchorPathRule, readHqPermissionRules } from './rules';

export interface SessionDeny {
  /** hq deny rules (path rules anchored to the hq), the user's, then the forbidden-connector rules; no duplicates. */
  deny: string[];
  /** The forbidden-connector rules alone (org.yaml and accounts.local.yaml). */
  forbidden: string[];
  /** What is wrong with the forbidden lists (see `ForbiddenPatterns.problems`, plus patterns that are no deny rule): any problem locks MCP. */
  problems: string[];
  /** The real server names `deniedMcpServers` gets (the same list Settings shows as "Kept from starting"; never a claude.ai connector). */
  keptOut: string[];
}

export function sessionDeny(hqPath: string, userDeny: readonly string[]): SessionDeny {
  const patterns = readForbiddenPatterns(hqPath);
  const { rules: forbidden, problems: ruleProblems } = forbiddenDenyRules(patterns);
  const hq = readHqPermissionRules(hqPath).deny.map((r) => anchorPathRule(r, hqPath));
  const deny = [...new Set([...hq, ...userDeny, ...forbidden])];
  const keptOut = serversKeptOut(deny, rawServerNames([...patterns.org, ...patterns.local]), hqMcpServerNames(hqPath));
  return { deny, forbidden, problems: [...patterns.problems, ...ruleProblems], keptOut };
}

/** The deny list of a chat process (see `sessionDeny`). */
export const sessionDenyRules = (hqPath: string, userDeny: readonly string[]): string[] => sessionDeny(hqPath, userDeny).deny;
