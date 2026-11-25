// Live status of the org chart's nodes, from what the app already knows (tabs and thread states). Pure: the main
// process uses it for `getOrgChart`, the renderer for every later change (thread-state and tabs events).
import { dict } from './own';
import type { OrgChartLive, TabInfo } from './types';

/** The queue tag of a handoff waiting for the chief of staff: `handoff:<tabId>`. */
export const HANDOFF_TAG = 'handoff:';

export interface ChartThreadState {
  busy: boolean;
  handoffsWaiting?: number;
  /** Tab ids of the handoffs waiting for the chief of staff (CoS thread). */
  handoffTabs?: string[];
}

/**
 * `departments` are the chart's (id and agent). `tabs` are the org's chats. `thread` gives the state of a thread id
 * (`cos` or `tab:<id>`), undefined when the thread has no process.
 */
export function buildOrgChartLive(
  departments: Array<{ id: string; agent: string }>,
  tabs: TabInfo[],
  thread: (threadId: 'cos' | `tab:${string}`) => ChartThreadState | undefined,
): OrgChartLive {
  const cos = thread('cos');
  const waitingTabs = new Set(cos?.handoffTabs ?? []);
  const live: OrgChartLive = { cos: { busy: !!cos?.busy, handoffsWaiting: cos?.handoffsWaiting ?? 0 }, departments: dict() };
  for (const d of departments) {
    // An open chat is one not ended; a department has at most one.
    const mine = tabs.filter((x) => x.agent === d.agent && (x.status === 'open' || x.status === 'handing-over'));
    const pick = mine[0];
    live.departments[d.id] = {
      running: mine.some((x) => !!thread(`tab:${x.tabId}`)?.busy),
      openTabId: pick?.tabId ?? null,
      handingOver: mine.some((x) => x.status === 'handing-over'),
      // The chat that handed over is closed by now: look at every chat of the agent.
      handoffWaiting: tabs.some((x) => x.agent === d.agent && waitingTabs.has(x.tabId)),
    };
  }
  return live;
}
