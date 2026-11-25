// What a click on the org chart does. Pure, so it can be tested without the DOM.
import type { OrgChart, OrgChartLive, OrgChartWorker, TabInfo } from '../shared/types';
import { modelLabel } from '../shared/model-label';
import { own } from '../shared/own';
import { t, tn } from '../shared/strings';

export type ChartAction =
  /** Select the chief of staff thread. */
  | { kind: 'cos' }
  /** An open chat is in the tab strip: select it. */
  | { kind: 'focus'; tabId: string }
  /** No open chat: start one with this agent (the side panel's Chat button; the main process also returns the open one). */
  | { kind: 'start'; agent: string };

export function departmentClick(dept: { id: string; agent: string }, live: OrgChartLive | null, tabs: TabInfo[]): ChartAction {
  const tabId = own(live?.departments, dept.id)?.openTabId ?? null;
  const tab = tabId ? tabs.find((x) => x.tabId === tabId) : undefined;
  if (!tab) return { kind: 'start', agent: dept.agent };
  return { kind: 'focus', tabId: tab.tabId };
}

export const cosClick = (): ChartAction => ({ kind: 'cos' });

// ---------- status, names and keyboard (spec sections 3 and 5) ----------

/** The one status a node shows, in the spec's order: the highest that applies. */
export type NodeStatus = 'agentMissing' | 'handingOver' | 'handoffWaiting' | 'working' | 'chatOpen';

export function nodeStatus(f: { agentMissing?: boolean; handingOver?: boolean; handoffWaiting?: boolean; working?: boolean; chatOpen?: boolean }): NodeStatus | null {
  if (f.agentMissing) return 'agentMissing';
  if (f.handingOver) return 'handingOver';
  if (f.handoffWaiting) return 'handoffWaiting';
  if (f.working) return 'working';
  if (f.chatOpen) return 'chatOpen';
  return null;
}

/** "opus" is "Opus", "claude-opus-5-5" is "Opus 5.5"; a missing model is empty. */
export function modelName(m: string | null | undefined): string {
  const name: string = m ?? '';
  if (!name) return '';
  return /claude-/i.test(name) ? modelLabel(name) : name.charAt(0).toUpperCase() + name.slice(1);
}

/** The models of a set of workers as one muted text: "Sonnet", or "Sonnet, Haiku" when they differ. */
export function workerModels(workers: OrgChartWorker[]): string {
  return [...new Set(workers.map((w) => modelName(w.model)).filter(Boolean))].join(', ');
}

/** The words of a status; `count` is the number of handoffs on the chief of staff node. */
export function statusWords(s: NodeStatus, count = 0): string {
  if (s === 'handoffWaiting' && count > 0) return tn('orgchart.handoffs', count);
  return t(`orgchart.status.${s}`);
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The accessible name of a node: "Max, Engineering, Opus, working. Helpers: reader, worker, Sonnet." The status and
 * the helpers are in the name, so colour and icons are never the only signal.
 */
export function nodeAccessibleName(n: { name: string; role?: string; model?: string | null; status?: string; workers?: OrgChartWorker[] }): string {
  const head = [n.name, n.role, modelName(n.model), n.status ? lowerFirst(n.status) : ''].filter(Boolean).join(', ');
  const workers = n.workers ?? [];
  if (workers.length === 0) return head;
  const models = workerModels(workers);
  return `${head}. ${t('orgchart.helpers', { names: [...workers.map((w) => w.name), ...(models ? [models] : [])].join(', ') })}`;
}

/** A node of the chart for keyboard focus: `ceo`, `cos` or `dept:<id>`. */
export type ChartNodeId = 'ceo' | 'cos' | `dept:${string}`;

/**
 * Where a key moves the focus. Up goes to the parent, Down to the first child, Left and Right between the departments
 * (the siblings, wrapping from the end of a grid row to the start of the next and from the last back to the first),
 * Home to the CEO, End to the last department (the chief of staff when there is none). `null`: not a chart key.
 */
export function nextChartNode(key: string, current: ChartNodeId, departmentIds: string[]): ChartNodeId | null {
  const dept = (i: number): ChartNodeId => `dept:${departmentIds[i]}`;
  const i = current.startsWith('dept:') ? departmentIds.indexOf(current.slice(5)) : -1;
  switch (key) {
    case 'ArrowUp':
      return current === 'ceo' ? 'ceo' : current === 'cos' ? 'ceo' : 'cos';
    case 'ArrowDown':
      return current === 'ceo' ? 'cos' : current === 'cos' ? (departmentIds.length ? dept(0) : 'cos') : current;
    case 'ArrowRight':
      return i < 0 ? current : dept((i + 1) % departmentIds.length);
    case 'ArrowLeft':
      return i < 0 ? current : dept((i - 1 + departmentIds.length) % departmentIds.length);
    case 'Home':
      return 'ceo';
    case 'End':
      return departmentIds.length ? dept(departmentIds.length - 1) : 'cos';
    default:
      return null;
  }
}

/** What the live region says when the chart changed: "Nora added.", "Nora removed.", "Max renamed to Mia." or "Updated.". Empty when nothing visible changed. */
export function chartChangeMessage(prev: OrgChart | null, next: OrgChart): string {
  if (!prev || prev.error || next.error) return '';
  const parts: string[] = [];
  const before = new Map(prev.departments.map((d) => [d.id, d]));
  const after = new Map(next.departments.map((d) => [d.id, d]));
  for (const d of next.departments) if (!before.has(d.id)) parts.push(t('orgchart.change.added', { name: d.displayName }));
  for (const d of prev.departments) if (!after.has(d.id)) parts.push(t('orgchart.change.removed', { name: d.displayName }));
  for (const d of next.departments) {
    const old = before.get(d.id);
    if (old && old.displayName !== d.displayName) parts.push(t('orgchart.change.renamed', { from: old.displayName, to: d.displayName }));
    else if (old && old.model !== d.model) parts.push(t('orgchart.change.model', { name: d.displayName, model: modelName(d.model) || t('orgchart.change.noModel') }));
  }
  if (prev.cos.displayName !== next.cos.displayName) parts.push(t('orgchart.change.renamed', { from: prev.cos.displayName, to: next.cos.displayName }));
  else if (prev.cos.model !== next.cos.model) parts.push(t('orgchart.change.model', { name: next.cos.displayName, model: modelName(next.cos.model) || t('orgchart.change.noModel') }));
  if (parts.length === 0) return '';
  return t('orgchart.updatedLive', { change: parts.join(' ') });
}
