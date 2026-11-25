// Pure helpers of the Settings window: the section list's keyboard moves and the About rows.
import type { AboutInfo, AvailableConnector, ConnectorDepartment, OrgIconResult, Settings, SettingsPatch } from '../shared/types';
import { t } from '../shared/strings';

/** Where focus (and the selection) goes on a key in the vertical section list: Up and Down wrap, Home and End jump. Null for any other key. */
export function nextSection<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length === 0) return null;
  if (key === 'ArrowDown') return ids[(i + 1) % ids.length];
  if (key === 'ArrowUp') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

export interface AboutRow {
  key: string;
  label: string;
  /** "Unknown" when the main process does not know the value. */
  value: string;
  known: boolean;
  /** Shown in the mono face (versions, ranges, paths). */
  mono: boolean;
}

/** The read-only rows of the About section, in order. A missing value reads "Unknown". */
export function aboutRows(a: AboutInfo): AboutRow[] {
  const row = (key: string, label: string, v: string | null): AboutRow => ({ key, label: t(label), value: v ?? t('settings.about.unknown'), known: v !== null, mono: true });
  return [
    row('app', 'settings.about.app', a.appVersion),
    row('claude', 'settings.about.claude', a.claudeVersion),
    row('claudeRange', 'settings.about.claudeRange', a.claudeRange),
    row('pluginInstalled', 'settings.about.pluginInstalled', a.pluginInstalled),
    row('pluginLatest', 'settings.about.pluginLatest', a.pluginLatest),
    row('framework', 'settings.about.framework', a.frameworkVersion),
    row('hq', 'settings.about.hq', a.hqPath),
  ];
}

export const REASON_MAX = 200;
/** Longest value of a code span in a request message (the reason has its own, `REASON_MAX`). */
export const SPAN_MAX = 120;

/** A value as one plain line: backticks are removed, control characters (newlines too) become spaces, whitespace collapsed, trimmed, cut at `max`. */
export function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/`/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** The reason as one line (see `oneLine`), cut at `REASON_MAX`. */
export function cleanReason(text: string): string {
  return oneLine(text, REASON_MAX);
}

/**
 * A value as data inside a request to the chief of staff: one line, no backtick (see `oneLine`), wrapped in one code span,
 * so nothing typed or read from a file can close the span or start a new line. An empty value is "(none)".
 */
export function codeSpan(value: string, max: number = SPAN_MAX): string {
  return `\`${oneLine(value, max) || '(none)'}\``;
}

/** One connector chip of a department: from org.yaml, from its agent file, or both; a mismatch is marked. */
export interface ConnectorChip {
  pattern: string;
  /** In org.yaml (the grant) but not in the agent file's tools line. */
  notInAgentFile: boolean;
  /** In the agent file's tools line but not in org.yaml. */
  notInOrgYaml: boolean;
}

/** The chips of a department: its org.yaml grants first, then the agent file entries that org.yaml does not list. */
export function connectorChips(d: Pick<ConnectorDepartment, 'granted' | 'inAgentFile'>): ConnectorChip[] {
  const chips: ConnectorChip[] = d.granted.map((pattern) => ({ pattern, notInAgentFile: !d.inAgentFile.includes(pattern), notInOrgYaml: false }));
  for (const pattern of d.inAgentFile) if (!d.granted.includes(pattern)) chips.push({ pattern, notInAgentFile: false, notInOrgYaml: true });
  return chips;
}

/** What the request form of a department offers: the hq's available patterns it does not have yet. */
export function offerable(available: readonly AvailableConnector[], d: Pick<ConnectorDepartment, 'granted'>): AvailableConnector[] {
  return available.filter((a) => !d.granted.includes(a.pattern));
}

/** The request to the chief of staff to grant a connector (the CoS prepares a decision card; the app writes nothing). */
export function grantMessage(d: Pick<ConnectorDepartment, 'displayName' | 'agent'>, pattern: string, reason: string): string {
  return t('cos.msg.connectorGrant', {
    pattern: codeSpan(pattern),
    department: codeSpan(d.displayName),
    agent: codeSpan(d.agent),
    reason: codeSpan(reason, REASON_MAX),
  });
}

/** The request to the chief of staff to remove a connector. */
export function removeMessage(d: Pick<ConnectorDepartment, 'displayName' | 'agent'>, pattern: string): string {
  return t('cos.msg.connectorRemove', { pattern: codeSpan(pattern), department: codeSpan(d.displayName), agent: codeSpan(d.agent) });
}

/** The line shown after a request is sent: when the settings view's org is not the main window's, it says whose chat holds the reply. */
export function sentNote(args: { cosName: string; orgName: string; orgId: string; activeOrgId: string | null }): string {
  const other = args.activeOrgId !== null && args.activeOrgId !== args.orgId;
  return other ? t('settings.connectors.sentOtherOrg', { cosName: args.cosName, orgName: args.orgName }) : t('settings.connectors.sent', { cosName: args.cosName });
}

/** What every section of the window receives: the selected org (not necessarily the main window's) and its settings. */
export interface SectionProps {
  orgId: string;
  /** Stamp of the org's icon file (`OrgSummary.iconStamp`), null when it has none. */
  iconStamp: string | null;
  orgName: string;
  /** The main window's active org (the settings view's org may differ). */
  activeOrgId: string | null;
  /** The org's chief of staff, by name (connector requests go to it). */
  cosName: string;
  settings: Settings | null;
  /** A change was made that reaches the org's chats only after "Apply now". */
  pending: boolean;
  applying: boolean;
  onChange(patch: SettingsPatch): void;
  onApply(): void;
  /** Something was changed that reaches the chats from their next message (a rule was removed). */
  onSessionChange(): void;
  /** A failure to show as a notice (a rule that could not be removed). */
  onError(text: string): void;
}

/** The scope names of Claude Code's `mcp_servers[].source` that have a plain label; anything else is shown as is. */
const SOURCE_LABELS = new Set(['project', 'local', 'user', 'claudeai']);
/** Statuses with a plain word; anything else is shown as is. */
const STATUS_LABELS = new Set(['connected', 'failed', 'needs-auth', 'pending']);

/** A connector's source as text for the user (`project` is "Project (.mcp.json)"); null when Claude Code gave none. */
export function sourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS.has(source) ? t(`settings.connectors.source.${source}`) : source;
}

/** A connector's status as plain words; an unknown status is shown as is. */
export function statusLabel(status: string): string {
  return STATUS_LABELS.has(status) ? t(`settings.connectors.status.${status}`) : status;
}

/** What to tell the user after an org icon pick: saved, or the error line to show; null when the picker was cancelled. */
export type OrgIconNotice = { kind: 'saved' } | { kind: 'removed' } | { kind: 'error'; key: 'orgIcon.error.tooLarge' | 'orgIcon.error.unsupported' | 'orgIcon.error.notAFile' | 'orgIcon.error.writeFailed' | 'orgIcon.error.removeFailed' };

export function orgIconNotice(r: OrgIconResult | null): OrgIconNotice | null {
  if (!r) return null;
  return r.ok ? { kind: 'saved' } : { kind: 'error', key: `orgIcon.error.${r.error}` };
}
