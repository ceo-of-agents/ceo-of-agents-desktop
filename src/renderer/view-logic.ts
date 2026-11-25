// What the main column shows: a chat (the chief of staff or a department) or the Org chart. The chart is a view, not a
// tab: the tab strip holds chats only, and `chartOpen` (per org) says whether the chart replaces the thread. The last chat
// stays remembered meanwhile, so closing the chart goes back to it. Pure helpers, no React.
import type { OrgId } from '../shared/types';

/** The id of the Org chart view (never a tab id). */
export const CHART_VIEW = 'org-chart';

/** Per org: is the Org chart shown instead of the thread. A missing org is closed. */
export type ChartOpen = Record<OrgId, boolean>;

/** The thread id of a department chat's tab. */
export const tabThreadId = (tabId: string): string => `tab:${tabId}`;

/** The tab strip's order: the chief of staff first, then the department chats. The chart is never in it. */
export function tabOrder(visibleTabs: ReadonlyArray<{ tabId: string }>): string[] {
  return ['cos', ...visibleTabs.map((x) => tabThreadId(x.tabId))];
}

export const isChartOpen = (open: ChartOpen, orgId: OrgId): boolean => open[orgId] === true;

/** Open the chart for an org. Returns the same object when it already is open. */
export function openChart(open: ChartOpen, orgId: OrgId): ChartOpen {
  return isChartOpen(open, orgId) ? open : { ...open, [orgId]: true };
}

/** Close the chart for an org. Returns the same object when it already is closed. */
export function closeChart(open: ChartOpen, orgId: OrgId): ChartOpen {
  return isChartOpen(open, orgId) ? { ...open, [orgId]: false } : open;
}

export function toggleChart(open: ChartOpen, orgId: OrgId): ChartOpen {
  return isChartOpen(open, orgId) ? closeChart(open, orgId) : openChart(open, orgId);
}

/** The chat the thread shows (or would show again when the chart closes): the remembered one, 'cos' when it is gone. */
export function currentChat(remembered: string | undefined, visibleTabs: ReadonlyArray<{ tabId: string }>): string {
  const wanted = remembered ?? 'cos';
  return tabOrder(visibleTabs).includes(wanted) ? wanted : 'cos';
}

/** What the main column shows for an org. */
export function viewFor(open: ChartOpen, orgId: OrgId): 'chart' | 'chat' {
  return isChartOpen(open, orgId) ? 'chart' : 'chat';
}
