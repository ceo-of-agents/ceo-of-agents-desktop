// The permission rules of one org as the Settings window lists them, and removing one rule saved with "Always allow".
import { asObject, hqLocalSettingsFile, hqSettingsFile, readJsonObject, updateHqLocalSettings } from './local-settings';
import { filterHqAllowRules, readHqPermissionRules } from './rules';
import type { AllowRuleEntry, DenyRuleEntry, PermissionRules } from '../../shared/types';

/** String entries of `permissions.<key>` of a settings file, as the rules code reads them (blank and multi-line entries skipped). */
function listOf(file: string, key: 'allow' | 'deny'): string[] {
  const v = asObject(readJsonObject(file).permissions)[key];
  const out: string[] = [];
  if (Array.isArray(v)) for (const r of v) if (typeof r === 'string' && r.trim() !== '' && !/[\r\n]/.test(r) && !out.includes(r)) out.push(r);
  return out;
}

/**
 * The org's rules. `dropped` is computed with `filterHqAllowRules` over both files, so it matches what sessions get.
 * `userDeny` are the user's own deny rules (`SettingsStore.userDenyRules()`); one equal to an hq rule is listed once, as the hq's.
 */
export function buildPermissionRules(hqPath: string, userDeny: readonly string[]): PermissionRules {
  const dropped = new Set(filterHqAllowRules(readHqPermissionRules(hqPath), hqPath).dropped);
  const entry = (rule: string): AllowRuleEntry => ({ rule, dropped: dropped.has(rule) });
  const hqDeny = readHqPermissionRules(hqPath).deny;
  const deny: DenyRuleEntry[] = hqDeny.map((rule) => ({ rule, source: 'hq' }));
  for (const rule of userDeny) if (!hqDeny.includes(rule) && !deny.some((d) => d.rule === rule)) deny.push({ rule, source: 'user' });
  return {
    hqAllow: listOf(hqSettingsFile(hqPath), 'allow').map(entry),
    savedAllow: listOf(hqLocalSettingsFile(hqPath), 'allow').map(entry),
    deny,
  };
}

/**
 * Removes exactly `rule` from `permissions.allow` of <hq>/.claude/settings.local.json (atomic merge: no other key is touched,
 * nothing is written when the rule is not there). Returns whether it was removed. Throws when the file is not valid JSON.
 */
export function removeSavedAllowRule(hqPath: string, rule: string): boolean {
  let removed = false;
  updateHqLocalSettings(hqPath, (data) => {
    const perms = asObject(data.permissions);
    if (!Array.isArray(perms.allow) || !perms.allow.includes(rule)) return false;
    perms.allow = perms.allow.filter((r) => r !== rule);
    data.permissions = perms;
    removed = true;
    return true;
  });
  return removed;
}
