// Pure logic of the renderer: helpers and the reducer that folds main-process events into one state.
import type {
  AppUpdateStatus,
  AppEvent, CoaApi, Dispatch, HealthColor, HealthStatus, Initiative, OrgChart, OrgId, OrgSummary, OrgView, PermissionMode, PermissionRequest, PlanUsage, PluginActionState,
  EffortLevel, PluginStatus, PrereqStatus, Settings, SettingsPatch, SettingSource, SignInState, TabInfo, ThreadEntry, ThreadId, ThreadInfo, WaitingEntry, WaitingItem,
} from '../shared/types';
import { t } from '../shared/strings';
import { clock } from './thread-logic';
import { isSpecificModel, modelLabel, tierOf } from '../shared/model-label';

export const threadKey = (orgId: OrgId, threadId: ThreadId | string): string => `${orgId}|${threadId}`;

// ---------- dates ----------

/** Local calendar day of an ISO time, as YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function shortDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export type ThreadRow =
  | { type: 'day'; day: string; time: string }
  | { type: 'entry'; entry: ThreadEntry }
  /** Consecutive old-style `tool` entries folded into one row (count only). */
  | { type: 'tools'; id: string; count: number; time: string };

/** Inserts a day row before the first entry of each local day, and folds runs of old `tool` entries into one row. */
export function withDaySeparators(entries: ThreadEntry[]): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let last = '';
  for (const entry of entries) {
    const day = localDay(entry.time);
    if (day !== last) {
      rows.push({ type: 'day', day, time: entry.time });
      last = day;
    }
    const prev = rows[rows.length - 1];
    if (entry.kind === 'tool') {
      if (prev && prev.type === 'tools') rows[rows.length - 1] = { ...prev, count: prev.count + 1 };
      else rows.push({ type: 'tools', id: entry.id, count: 1, time: entry.time });
      continue;
    }
    rows.push({ type: 'entry', entry });
  }
  return rows;
}

/** "1 step" or "12 steps". */
export function stepsLabel(count: number): string {
  return count === 1 ? t('activity.stepOne') : t('activity.stepMany', { count });
}

export type LivePhase = 'permission' | 'question' | 'writing' | 'step' | 'thinking';

/** What the live working line says: a pending question card, a pending permission card, then streaming text, then the current step, else thinking. */
export function livePhase(i: { permissionPending: boolean; questionPending?: boolean; streaming: string; current: string | null | undefined }): { phase: LivePhase; text: string } {
  if (i.questionPending) return { phase: 'question', text: t('activity.question') };
  if (i.permissionPending) return { phase: 'permission', text: t('activity.permission') };
  if (i.streaming) return { phase: 'writing', text: t('activity.writing') };
  if (i.current) return { phase: 'step', text: i.current };
  return { phase: 'thinking', text: t('activity.thinking') };
}

/** Elapsed time since an ISO start, as m:ss; empty when the start is unknown or invalid. */
export function elapsedLabel(startedAt: string | null | undefined, nowMs: number): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  return Number.isNaN(start) ? '' : clock(nowMs - start);
}

/** Cuts a line to `max` characters with an ellipsis. */
export function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Tabs shown in the strip: the open chats and the ones handing over. A closed chat leaves no trace. */
export function visibleTabsOf(tabs: TabInfo[]): TabInfo[] {
  return tabs.filter((x) => x.status !== 'closed');
}

/**
 * What the x or Cmd+W does for the selected thread: nothing for the CoS, an unknown thread or a chat that is
 * handing over; else the id of the tab to close.
 */
export function closeTargetFor(threadId: string, visible: TabInfo[]): string | null {
  if (threadId === 'cos') return null;
  const tab = visible.find((x) => `tab:${x.tabId}` === threadId);
  return tab && tab.status === 'open' ? tab.tabId : null;
}

/**
 * What closing a department chat does. A chat with work that was not handed over asks first: hand over, close without
 * handover, or cancel. A busy chat counts as having work: its first tool call may not have happened yet, so the flag
 * alone would let it close with nothing handed over. One that is idle with no pending work closes at once.
 * ('confirm-busy' is kept for callers; this function no longer returns it.)
 */
export type CloseDecision = 'ask-handover' | 'confirm-busy' | 'close';
export function closeDecision(tab: Pick<TabInfo, 'pendingWork'>, busy: boolean): CloseDecision {
  return tab.pendingWork || busy ? 'ask-handover' : 'close';
}

/** The three choices of the close dialog. */
export type CloseChoice = 'handover' | 'close' | 'cancel';

/** Runs the API call a close choice stands for: a hand-over, or a close without one. Cancel does nothing. */
export function runCloseChoice(choice: CloseChoice, api: Pick<CoaApi, 'handOver' | 'closeTab'>, orgId: OrgId, tabId: string): Promise<void> | null {
  if (choice === 'handover') return api.handOver(orgId, tabId);
  if (choice === 'close') return api.closeTab(orgId, tabId);
  return null;
}

/** The step a busy department tab shows inside its button (compact); empty when idle. */
export function tabActivity(thread: ThreadInfo | undefined): string {
  if (!thread?.busy) return '';
  return shorten(thread.activity?.current || t('activity.thinking'), 28);
}

/** The tab to select for a key in the tab strip (ArrowLeft/Right wrap, Home, End), or null for any other key. */
export function nextTabId(ids: string[], current: string, key: string): string | null {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length === 0) return null;
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

// ---------- initiatives, waiting ----------

export interface InitiativeGroups {
  inProgress: Initiative[];
  onHold: Initiative[];
  closed: Initiative[];
}

export function groupInitiatives(list: Initiative[]): InitiativeGroups {
  const g: InitiativeGroups = { inProgress: [], onHold: [], closed: [] };
  for (const i of list) {
    if (i.state === 'paused') g.onHold.push(i);
    else if (i.state === 'done' || i.state === 'dropped') g.closed.push(i);
    else g.inProgress.push(i);
  }
  return g;
}

export function isWaitingItem(e: WaitingEntry): e is WaitingItem {
  return 'code' in e;
}

// ---------- prerequisites ----------

export type PrereqId = 'claude' | 'signin' | 'git' | 'plugin';
/** ok: true = fine, false = blocking, null = unknown for now. */
export interface PrereqCheck {
  id: PrereqId;
  ok: boolean | null;
}

export function prereqChecks(p: PrereqStatus): PrereqCheck[] {
  return [
    { id: 'claude', ok: p.claude.found && p.claude.supported },
    { id: 'signin', ok: p.signedIn },
    { id: 'git', ok: p.git.found && !p.git.devToolsMissing },
    { id: 'plugin', ok: p.plugin ? p.plugin.state === 'ok' : null },
  ];
}

/** True while any check fails: Claude Code missing or unsupported, not signed in, git missing, plugin not ok. */
export function isBlocking(p: PrereqStatus | null | undefined): boolean {
  if (!p) return false;
  return prereqChecks(p).some((c) => c.ok === false);
}

/** Label for the plugin badge in the top bar: one state. */
export function pluginLabel(s: PluginStatus | null | undefined): string {
  if (!s) return '';
  if (s.state !== 'ok') return t('plugin.label.notInstalled');
  if (!s.installed) return t('plugin.label.unknown');
  const hq = s.hqFrameworkVersion;
  if (!s.dev && s.updateAvailable && s.latest) return t('plugin.label.updatePlugin', { installed: s.installed, latest: s.latest });
  if (s.orgUpdateAvailable && hq) return t('plugin.label.updateHq', { org: hq, installed: s.installed });
  if (s.dev) return t('plugin.label.dev', { version: s.installed });
  if (s.latestCheckFailed) return t('plugin.label.latestUnknown', { installed: s.installed });
  return t('plugin.label', { version: s.installed });
}

/** Which buttons the plugin badge shows: the one Update (plugin or hq behind), or a retry of the latest-version check. */
export function pluginActions(s: PluginStatus | null | undefined): { update: boolean; retry: boolean } {
  if (!s || s.state !== 'ok') return { update: false, retry: false };
  const update = (!s.dev && s.updateAvailable) || s.orgUpdateAvailable;
  return { update, retry: !update && !s.dev && s.latestCheckFailed };
}

/** What the plugin badge shows next to the Update button. */
export interface PluginBadgeView {
  kind: 'label' | 'step' | 'done' | 'error';
  text: string;
}

/** The running step in words (null when no step is known). */
export function pluginStepLabel(step: PluginActionState['step'], cosName: string): string | null {
  return step ? t(`plugin.step.${step}`, { cosName }) : null;
}

/**
 * One state for the badge: the running step, the error, "Updated" (`showDone`, for a moment after success) or the version label.
 * Only the one Update (`action: 'update'`) counts; an install shows its own state elsewhere.
 */
export function pluginBadgeView(plugin: PluginStatus | null | undefined, action: PluginActionState | null | undefined, cosName: string, showDone: boolean): PluginBadgeView {
  const a = action?.action === 'update' ? action : null;
  if (a?.running) return { kind: 'step', text: pluginStepLabel(a.step, cosName) ?? t('plugin.updating') };
  if (a?.error) return { kind: 'error', text: a.error };
  if (a?.done && showDone) return { kind: 'done', text: t('plugin.done') };
  return { kind: 'label', text: pluginLabel(plugin) };
}

/** What the top bar's "Update app" shows. */
export interface AppUpdateView {
  label: string;
  title: string;
  button: string;
  disabled: boolean;
  busy: boolean;
  error: string | null;
}

/** Null (hidden) unless an update is available, being fetched, ready or failed. */
export function appUpdateView(s: AppUpdateStatus | null | undefined): AppUpdateView | null {
  if (!s || !s.latest) return null;
  const vars = { latest: s.latest, current: s.current };
  switch (s.state) {
    case 'available':
      return { label: '', title: t('appUpdate.title', vars), button: t('appUpdate.button'), disabled: false, busy: false, error: null };
    case 'downloading':
      return { label: t('appUpdate.downloading'), title: t('appUpdate.title', vars), button: t('appUpdate.downloading'), disabled: true, busy: true, error: null };
    case 'ready':
      return { label: '', title: t('appUpdate.restartTitle', vars), button: t('appUpdate.restart'), disabled: false, busy: false, error: null };
    case 'error':
      return { label: '', title: t('appUpdate.title', vars), button: t('appUpdate.retry'), disabled: false, busy: false, error: s.error ?? '' };
    default:
      return null;
  }
}

// ---------- settings (per org) ----------

/** True when a change needs the org's chats to restart before it applies (auto push does not). */
export function affectsSessions(patch: SettingsPatch): boolean {
  return patch.permissionMode !== undefined || patch.effort !== undefined || patch.model !== undefined;
}

export function settingSourceLabel(source: SettingSource): string {
  return t(`settings.source.${source}`);
}

/** A tier alias as the picker words it ("Opus (latest)": it follows the newest model of that tier); other names are only capitalised. */
export function aliasLabel(a: string): string {
  const tier = tierOf(a);
  return tier && a.toLowerCase() === tier ? t('model.latest', { name: capitalise(tier) }) : capitalise(a);
}

/** The model names the pickers offer: the aliases first, then the specific ids (seen ids deduplicated, the current ones always present). */
function modelNames(i: { tiers?: string[]; seen?: string[]; present?: (string | null | undefined)[] }): { value: string; label: string }[] {
  const aliases = i.tiers && i.tiers.length ? i.tiers : ['opus', 'sonnet', 'haiku'];
  const out = aliases.map((n) => ({ value: n, label: aliasLabel(n) }));
  const have = new Set(aliases);
  for (const id of [...(i.present ?? []), ...(i.seen ?? [])]) {
    if (!id || have.has(id)) continue;
    have.add(id);
    out.push({ value: id, label: isSpecificModel(id) ? modelLabel(id) : capitalise(id) });
  }
  return out;
}

/** Options of the CoS model select: "as set in org.yaml" (value ''), the aliases, then the specific models (seen ids and the current choice). */
export function modelOptions(s: Settings): { value: string; label: string }[] {
  const first = { value: '', label: t('settings.model.orgYaml', { value: s.orgYamlModel ?? t('settings.model.cliDefault') }) };
  return [first, ...modelNames({ tiers: s.modelTiers, seen: s.seenModels, present: [s.model] })];
}

/** The note under the CoS model select: "Pinned for this org: Opus 5.5" for a specific model, else where the value comes from. */
export function modelSourceNote(s: Settings): string {
  return isSpecificModel(s.model) ? t('settings.source.model.pinned', { value: modelLabel(s.model) }) : t(`settings.source.model.${s.cosModelSource}`);
}

/** Thread header text: the model and effort the chat runs on. Empty when unknown. */
export function runLabel(model: string | null | undefined, effort: string | undefined): string {
  if (effort === undefined || model === undefined) return '';
  return model ? t('thread.run', { model, effort }) : t('thread.run.default', { effort });
}

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** How a model name reads: a specific id as "Opus 5.5", an alias as "Opus", nothing as the Claude Code default. */
const nameOf = (m: string | null | undefined): string => (m ? (isSpecificModel(m) ? modelLabel(m) : capitalise(m)) : t('settings.model.cliDefault'));

/**
 * The model a chat shows: the resolved id of its running process when it matches what the chat wants (the alias's tier, the pinned id, or
 * anything when the Claude Code default is wanted), else the wanted name. `full` is the id for the tooltip (null when only an alias is known).
 */
export function chatModelFace(i: { choice: string | null | undefined; defaultModel: string | null; resolved?: string | null }): { name: string; full: string | null } {
  const wanted = i.choice || i.defaultModel;
  if (isSpecificModel(wanted)) return { name: modelLabel(wanted), full: wanted };
  const tier = tierOf(wanted);
  if (i.resolved && (!wanted || (tier && tierOf(i.resolved) === tier))) return { name: modelLabel(i.resolved), full: i.resolved };
  return { name: nameOf(wanted), full: null };
}

/** What the footer shows for the chat's model: "Model: Opus 5.5" once known, else "Model: Opus"; also when the chat follows the org default. */
export function chatModelShown(choice: string | null | undefined, defaultModel: string | null, resolved?: string | null): string {
  return t('thread.model.shown', { value: chatModelFace({ choice, defaultModel, resolved }).name });
}

/** The tooltip of the footer model: the full id, or nothing while only an alias is known. */
export function chatModelTip(choice: string | null | undefined, defaultModel: string | null, resolved?: string | null): string {
  return chatModelFace({ choice, defaultModel, resolved }).full ?? '';
}

/** The tooltip of an assistant name: the model of that turn, "Model: Opus 5.5 (claude-opus-5-5)". Empty when unknown. */
export function turnModelTip(model: string | undefined): string {
  if (!model) return '';
  const name = modelLabel(model);
  return t('thread.model.turn', { value: name === model ? model : `${name} (${model})` });
}

/** What the footer shows for the chat's effort: "Effort: High", also when the chat follows the org default. */
export function chatEffortShown(choice: EffortLevel | null | undefined, defaultEffort: EffortLevel): string {
  return t('thread.effort.shown', { value: t(`settings.effort.${choice || defaultEffort}`) });
}

/**
 * Options of a chat's model picker: the org default (value ''; "Org default (Opus)", or "Pinned for this org: Opus 5.5" for a pinned one), the
 * aliases ("Opus (latest)"), then the specific models (the chat's own choice, the ids seen in init messages, the resolved one).
 */
export function chatModelOptions(i: { defaultModel: string | null; defaultPinned?: boolean; tiers?: string[]; current?: string | null; seen?: string[]; resolved?: string | null }): { value: string; label: string }[] {
  const dn = nameOf(i.defaultModel);
  const first = { value: '', label: i.defaultPinned && i.defaultModel ? t('thread.model.pinned', { value: dn }) : t('thread.model.orgDefault', { value: dn }) };
  return [first, ...modelNames({ tiers: i.tiers, seen: i.seen, present: [i.current, i.resolved] })];
}

/** Options of a chat's effort picker: "Org default (<level>)", or "Department default, from its agent file (<level>)" (value ''), then every level. */
export function chatEffortOptions(defaultEffort: EffortLevel, fromAgent = false): { value: string; label: string }[] {
  return [{ value: '', label: t(fromAgent ? 'thread.effort.agentDefault' : 'thread.effort.orgDefault', { value: t(`settings.effort.${defaultEffort}`) }) }, ...EFFORT_LEVELS.map((l) => ({ value: l as string, label: t(`settings.effort.${l}`) }))];
}

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

/** What the footer shows for the org's permission mode: "Mode: Accept edits". */
export function chatModeShown(mode: PermissionMode | undefined): string {
  return t('thread.mode.shown', { value: t(`settings.mode.${mode ?? 'default'}`) });
}

/** The note under the header picker: a change waits for the chat's next message. */
export function runPendingNote(thread: ThreadInfo | undefined): string {
  return thread?.runPending ? t('thread.run.pending') : '';
}

// ---------- health ----------

export function healthLabel(color: HealthColor): string {
  return t(`health.label.${color}`);
}

// ---------- state and reducer ----------

export interface OrgData {
  view: OrgView | null;
  /** The org chart (org.yaml and agent files); null until loaded. */
  chart: OrgChart | null;
  tabs: TabInfo[];
  prereq: PrereqStatus | null;
  health: HealthStatus | null;
  pluginAction: PluginActionState | null;
  /** This org's settings, loaded when Settings opens. */
  settings: Settings | null;
  /** A change was made that reaches the chats only after "Apply now". */
  settingsPending: boolean;
  /** The chief of staff's dispatches: running ones and ended ones the user has not seen yet. */
  dispatches: Dispatch[];
}

/** What a toast's button does. Only one kind so far: focus the org's chief of staff thread. */
export interface NoticeAction {
  kind: 'focus-cos';
  /** The button's accessible name and tooltip. */
  label: string;
}

export interface Notice {
  id: number;
  orgId: OrgId | null;
  text: string;
  /** A real button inside the toast; a toast without one is just text. */
  action?: NoticeAction;
}

export interface AppState {
  loaded: boolean;
  orgs: OrgSummary[];
  activeOrgId: OrgId | null;
  /** Per org. */
  orgData: Record<OrgId, OrgData>;
  /** Per thread, keyed by `${orgId}|${threadId}`. */
  threads: Record<string, ThreadInfo>;
  permissions: PermissionRequest[];
  signIn: SignInState;
  /** Last plan usage Claude Code reported (app-wide), null before the first reply. */
  usage: PlanUsage | null;
  /** The app's own update status (app-wide), null before it is read. */
  appUpdate: AppUpdateStatus | null;
  notices: Notice[];
  nextNoticeId: number;
}

export type Action =
  | AppEvent
  | { type: 'set-active'; orgId: OrgId | null }
  | { type: 'thread-loaded'; info: ThreadInfo }
  | { type: 'tab-upsert'; tab: TabInfo }
  | { type: 'settings-pending'; orgId: OrgId; pending: boolean }
  | { type: 'notice-dismiss'; id: number };

export const initialState: AppState = {
  loaded: false,
  orgs: [],
  activeOrgId: null,
  orgData: {},
  threads: {},
  permissions: [],
  signIn: { running: false, url: null, error: null },
  usage: null,
  appUpdate: null,
  notices: [],
  nextNoticeId: 1,
};

const emptyOrgData = (): OrgData => ({ view: null, chart: null, tabs: [], prereq: null, health: null, pluginAction: null, settings: null, settingsPending: false, dispatches: [] });

function patchOrg(s: AppState, orgId: OrgId, patch: Partial<OrgData>): AppState {
  return { ...s, orgData: { ...s.orgData, [orgId]: { ...(s.orgData[orgId] ?? emptyOrgData()), ...patch } } };
}

function stubThread(orgId: OrgId, threadId: ThreadId): ThreadInfo {
  return { orgId, threadId, busy: false, handoffsWaiting: 0, title: '', speaker: '', entries: [], streaming: '' };
}

function patchThread(s: AppState, orgId: OrgId, threadId: ThreadId, fn: (t: ThreadInfo) => ThreadInfo): AppState {
  const key = threadKey(orgId, threadId);
  return { ...s, threads: { ...s.threads, [key]: fn(s.threads[key] ?? stubThread(orgId, threadId)) } };
}

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'orgs':
      return { ...s, loaded: true, orgs: a.orgs, activeOrgId: a.activeOrgId };
    case 'set-active':
      return { ...s, activeOrgId: a.orgId };
    case 'org-view':
      return patchOrg(s, a.orgId, { view: a.view });
    case 'org-chart':
      return patchOrg(s, a.orgId, { chart: a.chart });
    case 'tabs':
      return patchOrg(s, a.orgId, { tabs: a.tabs });
    case 'tab-upsert': {
      const tabs = s.orgData[a.tab.orgId]?.tabs ?? [];
      const next = tabs.some((x) => x.tabId === a.tab.tabId) ? tabs.map((x) => (x.tabId === a.tab.tabId ? a.tab : x)) : [...tabs, a.tab];
      return patchOrg(s, a.tab.orgId, { tabs: next });
    }
    case 'thread-loaded': {
      const info = a.info;
      return patchThread(s, info.orgId, info.threadId, (old) => {
        const ids = new Set(info.entries.map((e) => e.id));
        const extra = old.entries.filter((e) => !ids.has(e.id));
        return { ...info, entries: [...info.entries, ...extra], streaming: old.streaming.length > info.streaming.length ? old.streaming : info.streaming };
      });
    }
    case 'thread-entry':
      return patchThread(s, a.orgId, a.threadId, (old) => {
        if (old.entries.some((e) => e.id === a.entry.id)) return old;
        return { ...old, entries: [...old.entries, a.entry], streaming: a.entry.kind === 'assistant' ? '' : old.streaming };
      });
    case 'thread-delta':
      return patchThread(s, a.orgId, a.threadId, (old) => ({ ...old, streaming: old.streaming + a.text }));
    case 'thread-state':
      return patchThread(s, a.state.orgId, a.state.threadId, (old) => ({
        ...old,
        busy: a.state.busy,
        handoffsWaiting: a.state.handoffsWaiting,
        handoffTabs: a.state.handoffTabs,
        activity: a.state.activity ?? null,
        reportPending: !!a.state.reportPending,
        commands: a.state.commands ?? [],
        ...(a.state.runDefaults ? { model: a.state.model, effort: a.state.effort, runChoice: a.state.runChoice, runPending: a.state.runPending, runDefaults: a.state.runDefaults, modelTiers: a.state.modelTiers, permissionMode: a.state.permissionMode, seenModels: a.state.seenModels } : {}),
        ...(a.state.resolvedModel ? { resolvedModel: a.state.resolvedModel } : {}),
        streaming: a.state.busy ? old.streaming : '',
      }));
    case 'permission':
      if (s.permissions.some((p) => p.requestId === a.request.requestId)) return s;
      return { ...s, permissions: [...s.permissions, a.request] };
    case 'permission-resolved':
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== a.requestId) };
    case 'prereq':
      return a.orgId ? patchOrg(s, a.orgId, { prereq: a.status }) : s;
    case 'sign-in':
      return { ...s, signIn: a.state };
    case 'usage':
      return { ...s, usage: a.usage };
    case 'app-update':
      return { ...s, appUpdate: a.status };
    case 'plugin-action':
      return patchOrg(s, a.orgId, { pluginAction: a.state });
    case 'health':
      return patchOrg(s, a.orgId, { health: a.status });
    case 'settings':
      return patchOrg(s, a.orgId, { settings: a.settings });
    case 'settings-pending':
      return patchOrg(s, a.orgId, { settingsPending: a.pending });
    case 'notice':
      return { ...s, notices: [...s.notices, { id: s.nextNoticeId, orgId: a.orgId, text: a.text }], nextNoticeId: s.nextNoticeId + 1 };
    case 'dispatches':
      return patchOrg(s, a.orgId, { dispatches: a.dispatches });
    case 'dispatch-ended': {
      const d = a.dispatch;
      if (d.state !== 'done' && d.state !== 'failed' && d.state !== 'stopped') return s;
      const description = d.description.trim();
      const base = description ? t(`dispatch.ended.${d.state}`, { persona: d.name, description }) : t(`dispatch.ended.${d.state}Bare`, { persona: d.name });
      // A toast for an org that is not the one on screen names the org (as the macOS notification does).
      const summary = s.orgs.find((o) => o.id === a.orgId);
      const text = a.orgId !== s.activeOrgId && summary ? t('dispatch.ended.notification', { org: summary.name, text: base }) : base;
      const cosName = s.orgData[a.orgId]?.view?.org.cosName ?? summary?.cosName ?? t('cos.role');
      const notice: Notice = { id: s.nextNoticeId, orgId: a.orgId, text, action: { kind: 'focus-cos', label: t('dispatch.toast.open', { cosName }) } };
      return { ...s, notices: [...s.notices, notice], nextNoticeId: s.nextNoticeId + 1 };
    }
    case 'notice-dismiss':
      return { ...s, notices: s.notices.filter((n) => n.id !== a.id) };
    default:
      return s;
  }
}

/** Pending permission cards of one thread. */
export function permissionsFor(s: AppState, orgId: OrgId, threadId: ThreadId): PermissionRequest[] {
  return s.permissions.filter((p) => p.orgId === orgId && p.threadId === threadId);
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export type WaitingButton = 'approve' | 'decline' | 'done' | 'answer' | 'reply' | `option:${string}`;

/** Buttons for a pending item, by kind tag ({ok} Approve and Decline, {do} Done, {decide} the card options, or Answer
 * when they are unknown). Every item also gets Reply, except a `{wait}` group heading: it asks nothing and has no button. An item without a tag gets Reply only: it is not an approval. */
export function waitingButtons(item: WaitingItem): WaitingButton[] {
  if (item.action === 'wait') return [];
  if (item.action === 'ok') return ['approve', 'decline', 'reply'];
  if (item.action === 'do') return ['done', 'reply'];
  if (item.action === 'decide') {
    const options = item.options ?? [];
    return options.length >= 2 ? [...options.map((o): WaitingButton => `option:${o.key}`), 'reply'] : ['answer', 'reply'];
  }
  return ['reply'];
}

/** True for an item that shows the "update the org" hint: no kind tag. */
export const isUntagged = (item: WaitingItem): boolean => item.action === null;

/** Whole local days from a YYYY-MM-DD (or ISO) date to `now`; null when the date is missing or invalid. */
export function ageDays(since: string | null, now: Date = new Date()): number | null {
  if (!since) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(since);
  if (!m) return null;
  const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const to = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** Age in plain words: today, 1 day, 12 days. Empty when unknown. */
export function ageText(since: string | null, now: Date = new Date()): string {
  const d = ageDays(since, now);
  if (d === null) return '';
  return d === 0 ? t('waiting.age.today') : d === 1 ? t('waiting.age.one') : t('waiting.age.many', { count: d });
}

// ---------- side panel state ----------

export type PanelSection = 'waiting' | 'initiatives' | 'departments';
export type PanelState = Record<PanelSection, boolean>;

/** Every section open by default. */
export const defaultPanelState = (): PanelState => ({ waiting: true, initiatives: true, departments: true });

/** Minimal storage the panel state needs (the browser `localStorage` fits). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const panelStorageKey = (orgId: OrgId): string => `coa.panel.${orgId}`;

/** Open (true) or collapsed (false) state of each section of one org. Bad or missing data gives the defaults. */
export function loadPanelState(storage: KeyValueStorage, orgId: OrgId): PanelState {
  const state = defaultPanelState();
  try {
    const raw = storage.getItem(panelStorageKey(orgId));
    if (!raw) return state;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return state;
    for (const k of Object.keys(state) as PanelSection[]) {
      const v = (data as Record<string, unknown>)[k];
      if (typeof v === 'boolean') state[k] = v;
    }
  } catch {
    // unreadable storage or bad JSON: keep the defaults
  }
  return state;
}

export function savePanelState(storage: KeyValueStorage, orgId: OrgId, state: PanelState): void {
  try {
    storage.setItem(panelStorageKey(orgId), JSON.stringify(state));
  } catch {
    // storage full or blocked: the state just is not remembered
  }
}

// ---------- "Ask the chief of staff to fix it" (health popover) ----------

/** The request sent to the chief of staff for a problem between this hq and GitHub: a diagnosis and a plan, never a go-ahead. */
export function fixHqMessage(kind: 'diverged' | 'files'): string {
  return t(kind === 'files' ? 'cos.msg.fixHq.files' : 'cos.msg.fixHq.diverged');
}

/** The request an org's chief of staff gets for an unreadable org.yaml (`detail` is the parser's reason). */
export function fixOrgYamlMessage(detail: string): string {
  return t('cos.msg.fixOrgYaml', { detail });
}

/** The request for a department whose agent file is missing. */
export function fixAgentFileMessage(name: string, path: string): string {
  return t('cos.msg.fixAgentFile', { name, path });
}

/**
 * The synchronous half of the one-request-at-a-time guard. State updates land after the click handler returns, so two
 * fast clicks would both read "nothing pending"; this set is changed at once. True: the caller may send, and the org is
 * now claimed until `claimed.delete(orgId)` (done when the request ends or fails to send).
 */
export function claimAskFix(claimed: Set<string>, orgId: string, pending: boolean): boolean {
  if (pending || claimed.has(orgId)) return false;
  claimed.add(orgId);
  return true;
}

/** A request sent and not yet handled: `sentAt` (ms) when it was sent, `sawTurn` once a chief of staff turn started after it. */
export interface AskFixPending {
  sentAt: number;
  sawTurn: boolean;
}

/** How long a sent request may wait for its turn to start while the chief of staff is idle, before the button comes back. */
export const ASK_FIX_GRACE_MS = 30_000;

/**
 * The next state of a pending request, from what the chief of staff thread shows now. Only a turn that started at or
 * after the send counts (an earlier turn ending must not bring the button back while the request is still queued);
 * the request is done when that turn ends. While idle and no turn has started, it gives up after the grace time.
 */
export function askFixNext(p: AskFixPending | null, busy: boolean, turnStartedAt: number | null, now: number): AskFixPending | null {
  if (!p) return null;
  const ours = busy && turnStartedAt !== null && turnStartedAt >= p.sentAt;
  if (ours && !p.sawTurn) return { ...p, sawTurn: true };
  if (!busy && p.sawTurn) return null;
  if (!busy && !p.sawTurn && now - p.sentAt >= ASK_FIX_GRACE_MS) return null;
  return p;
}

// ---------- settings changes: the Auto mode confirm and save errors ----------

/** Switching to Auto mode asks first (Claude Code then runs commands without asking); other modes switch at once. */
export function needsAutoConfirm(current: PermissionMode | null | undefined, next: PermissionMode): boolean {
  return next === 'auto' && current !== 'auto';
}

/** The reason of a failed call to the main process, without Electron's "Error invoking remote method '…': Error:" prefix. */
export function ipcReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Z]\w*)?Error:\s*/, '').trim();
}

/** The file a settings change is written to, for an error message: the hq's local Claude Code settings, or the app's own file for auto push. */
export function settingsTarget(patch: SettingsPatch): string {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => k === 'autoPush' || k === 'newSessionAfterMinutes' || k === 'renewSessionAtTokens' || k === 'tips') ? t('settings.file.app') : '.claude/settings.local.json';
}

// ---------- ignored permission rules (health popover) ----------

/**
 * How many ignored rules the health popover line counts (both files; a rule written in both counts once) and how many
 * "Clean up" would remove (local file only).
 */
export function ignoredRulesCounts(health: Pick<HealthStatus, 'droppedRules'>): { total: number; local: number; project: number } {
  const local = health.droppedRules?.local ?? [];
  const project = health.droppedRules?.project ?? [];
  return { total: new Set([...local, ...project]).size, local: local.length, project: project.length };
}

/** The broad Artifact / AskUserQuestion allow rules (`HealthStatus.broadRules`): how many, and how many "Clean up" removes (local file only). */
export function broadRulesCounts(health: Pick<HealthStatus, 'broadRules'>): { total: number; local: number; project: number } {
  const local = health.broadRules?.local ?? [];
  const project = health.broadRules?.project ?? [];
  return { total: new Set([...local, ...project]).size, local: local.length, project: project.length };
}

// ---------- processes an earlier app run left running (health popover) ----------

/** Epoch ms as the time the popover shows: the time of day today, else the short date and time. */
export function leftoverStartedLabel(startedAt: number, now: Date = new Date()): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The indicator is yellow only because of leftover processes: no Sync button and the "Needs attention" label, not "Needs sync". */
export function leftoverOnly(health: Pick<HealthStatus, 'color' | 'leftoverProcesses' | 'ahead' | 'behind' | 'autoPushFailing' | 'conflict'>): boolean {
  return health.color === 'yellow' && (health.leftoverProcesses?.length ?? 0) > 0 && health.ahead === 0 && health.behind === 0 && !health.autoPushFailing && !health.conflict;
}
