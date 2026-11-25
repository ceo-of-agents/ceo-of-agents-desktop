// The app's org list and everything per org that is not a chat: watchers, prerequisites, plugin, hq health, auto push.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionBroker } from '../claude/permissions';
import { broadAllowRulesBySource, droppedRulesBySource, removeDroppedLocalRules } from '../claude/rules';
import { buildPermissionRules, removeSavedAllowRule } from '../claude/rule-lists';
import { parseOrgYaml } from '../hq/parse';
import { buildAbout } from './about';
import { orgIconStamp } from '../hq/org-icon';
import { isHq, loadHq, readInitiativeStatus, type LoadedHq } from '../hq/read';
import { findHqs, scanUsualPlaces } from '../hq/discover';
import { OrgRegistry } from '../hq/registry';
import { watchHq } from '../hq/watch';
import { affectsChart, ChartTracker } from '../hq/org-chart';
import { hqMcpServerNames, readConnectors } from '../hq/connectors';
import { caseWarnings, mcpLaunch } from '../hq/forbidden-connectors';
import { sessionDeny } from '../claude/session-deny';
import { checkPrereqs } from '../system/prereqs';
import { spawnProcess } from '../system/exec';
import { trackedSpawner, type Leftover, type ProcessLedger } from '../claude/process-ledger';
import { devPluginStatus, installPlugin, pluginStatus, updatePlugin, fetchLatestRelease } from '../system/plugin';
import { checkHealth, pullOnOpen, sync as gitSync } from '../git/health';
import { AutoPusher } from '../git/autopush';
import { ALLOW_UNSUPPORTED_ENV, DEV, MIN_PLUGIN_VERSION } from '../config';
import type { SettingsStore } from '../settings';
import { OrgSession, threadKey } from './org-session';
import type { GuardScope, RunningItem } from './run-guard';
import { runOrgUpdate } from './update-org';
import type { TurnResult } from './thread';
import { t, tn } from '../../shared/strings';
import { emptyChart } from '../hq/org-chart';
import { endedNotificationText } from './dispatches';
import { UsageTracker } from '../claude/usage-tracker';
import { UsageRefresher } from '../claude/usage-refresh';
import { findPluginDir } from '../setup/plugin-data';
import { PluginTipsSource } from '../tips/plugin-tips';
import { TipsService } from '../tips/service';
import type { Tip, AboutInfo, AppEvent, ConnectorsInfo, Department, Dispatch, HealthStatus, OrgChart, OrgChartLive, OrgId, OrgSummary, OrgView, PermissionRules, PluginStatus, PrereqStatus, Settings, SettingsPatch, ThreadId } from '../../shared/types';
import { countAsks } from '../../shared/waiting';

interface OrgRuntime {
  session: OrgSession | null;
  watcher: { close(): void } | null;
  pusher: AutoPusher | null;
  lastSyncAt: string | null;
  syncing: boolean;
  plugin: PluginStatus | null;
  health: HealthStatus | null;
  /** Called when a status refresh shows the hq no longer lags the plugin (see `waitForCosTurn`). */
  hqCurrentWaiters: Set<() => void>;
  chart: ChartTracker | null;
  /** Departments of the last good read of org.yaml, for the side panel while the file is unreadable. */
  lastDepartments: Department[] | null;
}

export interface OrgManagerDeps {
  dataDir: string;
  settings: SettingsStore;
  broker: PermissionBroker;
  serverScript: string;
  nodePath: string;
  emit: (e: AppEvent) => void;
  notify?: (title: string, body: string) => void;
  /** How often a wait for the chief of staff checks that the org and message are still there (ms, default 1000). */
  cosPollMs?: number;
  /** Running work may have changed in any org (a dispatch, a chief of staff thread's busy state): the run guard looks again. */
  onRunningChange?: () => void;
  /** The `claude -p` processes this app starts, recorded so that an earlier run's leftovers are found and this run's are stopped. */
  ledger?: ProcessLedger;
  /** Delay before the one re-read of the hq version when it still lags after the chief of staff's turn (ms, default 3000). */
  updateRecheckMs?: number;
}

export class OrgManager {
  readonly registry: OrgRegistry;
  private readonly rt = new Map<OrgId, OrgRuntime>();
  /** `claude -p` processes earlier runs left behind, per org (from the process ledger). */
  private leftovers = new Map<OrgId, Leftover[]>();
  private prereq: PrereqStatus | null = null;
  private claudePath: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Orgs with an Update running (held for the whole run, including the wait for the chief of staff). */
  private readonly updating = new Set<OrgId>();
  /** Plan usage from every chat's `rate_limit_event` (app-wide: one Claude Code sign-in). */
  readonly usage: UsageTracker;
  /** Reads `claude -p /usage` (no model call) while every chat is idle, and on the user's Refresh. */
  readonly usageRefresh: UsageRefresher;
  /** Contextual tips above the composer: the installed plugin's tips file plus the app's own. */
  private readonly tips: TipsService;

  constructor(private readonly d: OrgManagerDeps) {
    this.registry = new OrgRegistry(d.dataDir);
    this.usage = new UsageTracker({ emit: d.emit, notify: d.notify });
    this.tips = new TipsService({
      settings: d.settings,
      // The plugin is found where `claude plugin list` says it is installed (COA_PLUGIN_DIR in development), the way the setup wizard does.
      plugin: new PluginTipsSource(async () => (this.claudePath || DEV.pluginDir ? findPluginDir(this.claudePath ?? '') : null)),
    });
    this.usageRefresh = new UsageRefresher({
      claudePath: () => (this.canStart() === null ? this.claudePath : null),
      claudeVersion: () => this.prereq?.claude.version ?? null,
      last: () => this.usage.get(),
      update: (info) => this.usage.update(info),
      busy: () => this.runningItems('all').length > 0,
    });
  }

  // ---------- startup ----------

  async init(): Promise<void> {
    if (!this.registry.scannedOnce()) {
      for (const p of scanUsualPlaces(DEV.scanRoot ?? os.homedir())) this.registry.add(p);
      this.registry.markScanned();
    }
    this.d.settings.migrateLegacy(this.registry.list());
    await this.refreshLeftovers();
    for (const o of this.registry.list()) this.watch(o.id);
    await this.refreshPrereqs(null);
    this.usageRefresh.start();
    void this.usageRefresh.tick();
    this.timer = setInterval(() => {
      const id = this.registry.activeId();
      if (id) void this.refreshHealth(id, true);
    }, 5 * 60 * 1000);
  }

  async shutdown(): Promise<void> {
    // No new process from now on (a thread that was about to start one fails its turn), then stop the ones that run.
    this.d.ledger?.close();
    if (this.timer) clearInterval(this.timer);
    this.usageRefresh.stop();
    try {
      for (const r of this.rt.values()) {
        r.watcher?.close();
        r.pusher?.stop();
        await r.session?.stopAll();
      }
    } finally {
      // Whatever is still alive (a stop that failed or was cut short) goes now.
      this.d.ledger?.killAllSync('SIGKILL');
    }
  }

  /** Reads the process ledger for `claude -p` processes an earlier run left running (cheap: nothing runs when the ledger has no foreign line). */
  private async refreshLeftovers(): Promise<void> {
    const ledger = this.d.ledger;
    if (!ledger) return;
    try {
      this.leftovers = ledger.hasForeign() ? await ledger.findLeftovers(this.registry.list()) : new Map();
    } catch {
      this.leftovers = new Map();
    }
  }

  /** The "Stop" button of a leftover process in the health popover; false when it is not one of this app's leftovers in that org. */
  async stopLeftoverProcess(orgId: OrgId, pid: number): Promise<boolean> {
    const ledger = this.d.ledger;
    if (!ledger || !this.registry.get(orgId)) return false;
    const ok = await ledger.stopLeftover(orgId, pid, this.registry.list());
    await this.refreshHealth(orgId, false);
    return ok;
  }

  /** Orgs that have a session (department chats exist only there), for the quit check. */
  liveSessions(): Array<{ orgId: OrgId; orgName: string; cosName: string; session: OrgSession }> {
    const out: Array<{ orgId: OrgId; orgName: string; cosName: string; session: OrgSession }> = [];
    for (const [orgId, r] of this.rt) {
      if (!r.session) continue;
      const sum = this.summaries().find((x) => x.id === orgId);
      out.push({ orgId, orgName: sum?.name ?? orgId, cosName: sum?.cosName ?? t('cos.role'), session: r.session });
    }
    return out;
  }

  // ---------- orgs ----------

  summaries(): OrgSummary[] {
    return this.registry.list().map((e) => {
      const available = isHq(e.path);
      if (!available) return { id: e.id, path: e.path, name: path.basename(e.path), cosName: t('cos.role'), waitingCount: 0, lastOpened: e.lastOpened, available, iconStamp: null };
      const hq = loadHq(e.path);
      return {
        id: e.id,
        path: e.path,
        name: hq.org.name || path.basename(e.path),
        cosName: hq.org.cosName,
        waitingCount: countAsks(hq.waiting),
        lastOpened: e.lastOpened,
        available,
        iconStamp: orgIconStamp(e.path),
      };
    });
  }

  /** The org to show: the last used one, else the first available one. */
  defaultOrgId(): OrgId | null {
    return this.registry.lastUsed() ?? this.summaries().find((s) => s.available)?.id ?? null;
  }

  emitOrgs(): void {
    this.d.emit({ type: 'orgs', orgs: this.summaries(), activeOrgId: this.defaultOrgId() });
  }

  /** Adds the hq found in or below `folder`. Returns null (and a notice) when there is none. */
  addFromFolder(folder: string): OrgSummary | null {
    const found = findHqs(folder, 3);
    if (!found.length) {
      this.d.emit({ type: 'notice', orgId: null, text: t('org.noHq') });
      return null;
    }
    let first: OrgSummary | null = null;
    for (const p of found) {
      const e = this.registry.add(p);
      this.watch(e.id);
      if (!first) first = this.summaries().find((s) => s.id === e.id) ?? null;
    }
    this.emitOrgs();
    return first;
  }

  view(orgId: OrgId): OrgView | null {
    const e = this.registry.get(orgId);
    if (!e || !isHq(e.path)) return null;
    const hq = loadHq(e.path);
    const org = this.summaries().find((s) => s.id === orgId)!;
    const { departments, unreadable } = this.panelDepartments(orgId, hq);
    return { org, departments, waiting: hq.waiting, initiatives: hq.initiatives, frameworkVersion: hq.org.frameworkVersion, ...(unreadable ? { orgUnreadable: true } : {}) };
  }

  /**
   * The Departments list of the side panel agrees with the chart: while org.yaml cannot be read, the departments of the
   * last good read stay (the chart keeps its last good chart the same way); with no good read yet there are none.
   */
  private panelDepartments(orgId: OrgId, hq: LoadedHq): { departments: Department[]; unreadable: boolean } {
    const r = this.runtime(orgId);
    if (hq.orgReadable) {
      r.lastDepartments = hq.departments;
      return { departments: hq.departments, unreadable: false };
    }
    return r.lastDepartments ? { departments: r.lastDepartments, unreadable: false } : { departments: [], unreadable: true };
  }

  async activate(orgId: OrgId): Promise<OrgView | null> {
    const e = this.registry.get(orgId);
    if (!e || !isHq(e.path)) return null;
    this.registry.setActive(orgId);
    this.registry.touch(orgId);
    this.session(orgId);
    this.emitOrgs();
    const r = this.runtime(orgId);
    if (!r.pusher) {
      r.pusher = new AutoPusher(e.path, { enabled: () => this.d.settings.autoPush(orgId) });
      r.pusher.on('pushed', () => {
        // Quiet: sync state lives in the health indicator, not in the thread.
        r.lastSyncAt = new Date().toISOString();
        void this.refreshHealth(orgId, false);
      });
      // Only a failure that persisted is emitted by the pusher.
      r.pusher.on('push-failed', () => void this.refreshHealth(orgId, false));
      // Any new commit changes ahead/behind, also when auto push is off.
      r.pusher.on('head-moved', () => void this.refreshHealth(orgId, false));
      await r.pusher.start();
    }
    // Pull on open, then check everything in the background.
    void (async () => {
      const pulled = await pullOnOpen(e.path);
      if (pulled.ok) r.lastSyncAt = new Date().toISOString();
      await this.refreshPrereqs(orgId);
      await this.refreshHealth(orgId, true);
      this.emitView(orgId);
    })();
    return this.view(orgId);
  }

  session(orgId: OrgId): OrgSession {
    const r = this.runtime(orgId);
    if (r.session) return r.session;
    const e = this.registry.get(orgId);
    if (!e) throw new Error('Unknown org.');
    r.session = new OrgSession(orgId, e.path, path.join(this.d.dataDir, 'orgs', orgId), {
      claudePath: () => this.claudePath,
      spawner: this.d.ledger ? trackedSpawner(this.d.ledger, spawnProcess, { orgId, hqPath: e.path }) : undefined,
      settings: () => this.d.settings.get(orgId, e.path),
      userDeny: () => this.d.settings.userDenyRules(),
      userArtifactSettings: () => this.d.settings.userArtifactSettings(),
      seenModels: this.d.settings.seen(orgId),
      broker: this.d.broker,
      serverScript: this.d.serverScript,
      nodePath: this.d.nodePath,
      canStart: () => this.canStart(),
      emit: this.d.emit,
      onHandoff: (id, persona) => {
        const name = this.summaries().find((s) => s.id === id)?.name ?? '';
        const text = t('notice.handedOver', { org: name, persona });
        this.d.emit({ type: 'notice', orgId: id, text });
        this.d.notify?.(name, text);
      },
      onRunningChange: () => this.d.onRunningChange?.(),
      onRateLimit: (info) => this.usage.update(info),
      newSessionAfterMs: () => this.d.settings.newSessionAfterMinutes(orgId) * 60_000,
      renewSessionAtTokens: () => this.d.settings.renewSessionAtTokens(orgId),
      onIdleAside: (id, speaker) => {
        const name = this.summaries().find((s) => s.id === id)?.name ?? '';
        const text = t('notice.wroteOnOwn', { org: name, persona: speaker });
        this.d.emit({ type: 'notice', orgId: id, text });
        this.d.notify?.(name, text);
      },
      onDispatches: (dispatches) => this.d.emit({ type: 'dispatches', orgId, dispatches }),
      onDispatchEnded: (dispatch) => {
        this.d.emit({ type: 'dispatch-ended', orgId, dispatch });
        const name = this.summaries().find((s) => s.id === orgId)?.name ?? '';
        this.d.notify?.(name, endedNotificationText(dispatch));
      },
    });
    return r.session;
  }

  /** Maps a permission broker thread key back to its org and thread. */
  static parseThreadKey(key: string): { orgId: OrgId; threadId: ThreadId } {
    const i = key.indexOf('|');
    return { orgId: key.slice(0, i), threadId: key.slice(i + 1) as ThreadId };
  }

  static threadKey = threadKey;

  private runtime(orgId: OrgId): OrgRuntime {
    let r = this.rt.get(orgId);
    if (!r) {
      r = { session: null, watcher: null, pusher: null, lastSyncAt: null, syncing: false, plugin: null, health: null, hqCurrentWaiters: new Set(), chart: null, lastDepartments: null };
      this.rt.set(orgId, r);
    }
    return r;
  }

  private watch(orgId: OrgId): void {
    const r = this.runtime(orgId);
    const e = this.registry.get(orgId);
    if (r.watcher || !e || !fs.existsSync(e.path)) return;
    r.watcher = watchHq(e.path, (what) => {
      if (what === 'org') r.session?.refreshNames();
      if (what === 'inbox') r.session?.refreshInbox();
      if (what === 'state' || what === 'org' || what === 'icon') this.emitOrgs();
      if (what === 'org') void this.refreshPrereqs(orgId);
      if (what === 'settings') void this.refreshHealth(orgId, false); // a rule added by hand or by a pull
      if (what !== 'inbox' && what !== 'agents' && what !== 'look' && what !== 'settings' && what !== 'icon') this.emitView(orgId);
      if (affectsChart(what)) this.emitChart(orgId);
    });
  }

  private chartTracker(orgId: OrgId): ChartTracker | null {
    const r = this.runtime(orgId);
    const e = this.registry.get(orgId);
    if (!r.chart && e) r.chart = new ChartTracker(e.path);
    return r.chart;
  }

  /** The chart (org.yaml and `.claude/agents/`) and the live status of its nodes. */
  orgChart(orgId: OrgId): { chart: OrgChart; live: OrgChartLive } {
    const chart = this.chartTracker(orgId)?.read() ?? emptyChart(t('orgChart.err.missing'));
    return { chart, live: this.session(orgId).chartLive(chart.departments) };
  }

  /** Emits `org-chart` when the chart now differs from the last one read. */
  private emitChart(orgId: OrgId): void {
    const chart = this.chartTracker(orgId)?.changed();
    if (chart) this.d.emit({ type: 'org-chart', orgId, chart });
  }

  private emitView(orgId: OrgId): void {
    const v = this.view(orgId);
    if (v) this.d.emit({ type: 'org-view', orgId, view: v });
  }

  // ---------- prerequisites and plugin ----------

  canStart(): string | null {
    const c = this.prereq?.claude;
    if (!c || !c.found || !this.claudePath) return t('claude.missing');
    if (!c.supported && process.env[ALLOW_UNSUPPORTED_ENV] !== '1') return t('claude.unsupported', { version: c.version ?? '?', range: c.range });
    if (this.prereq?.signedIn === false) return t('signin.required');
    return null;
  }

  /** The claude binary when sessions may start, else null (the same rule as the org chats). */
  claudeBinary(): string | null {
    return this.canStart() === null ? this.claudePath : null;
  }

  lastPrereq(): PrereqStatus | null {
    return this.prereq;
  }

  async refreshPrereqs(orgId: OrgId | null): Promise<PrereqStatus> {
    const hqPath = orgId ? (this.registry.get(orgId)?.path ?? null) : null;
    const p = await checkPrereqs({ hqPath, fetchLatest: () => fetchLatestRelease() });
    this.claudePath = p.claude.path;
    if (p.plugin && DEV.pluginDir) p.plugin = devPluginStatus(p.plugin, DEV.pluginDir);
    this.prereq = p;
    if (orgId) {
      const r = this.runtime(orgId);
      r.plugin = p.plugin;
      if (p.plugin?.state === 'ok' && !p.plugin.orgUpdateAvailable) for (const fn of [...r.hqCurrentWaiters]) fn();
    }
    this.d.emit({ type: 'prereq', orgId, status: p });
    return p;
  }

  async installPlugin(orgId: OrgId): Promise<void> {
    await this.pluginAction(orgId, 'install', (claude, hq) => installPlugin(claude, hq));
  }

  /** The one Update button: plugin (when behind), restart, then the chief of staff applies the hq migrations. One run per org at a time. */
  async updateOrg(orgId: OrgId): Promise<void> {
    const e = this.registry.get(orgId);
    if (!e || !this.claudePath || this.updating.has(orgId)) return;
    this.updating.add(orgId);
    const claude = this.claudePath;
    let waiting: Promise<void> = Promise.resolve();
    try {
      await runOrgUpdate({
        status: async () => (await this.refreshPrereqs(orgId)).plugin,
        updatePlugin: () => updatePlugin(claude, e.path),
        restart: async () => {
          await this.rt.get(orgId)?.session?.restartSessions();
        },
        sendToCos: (text) => {
          const tag = `apply-hq-update:${Date.now()}`;
          // Listen before the message is sent, so the end of its turn cannot be missed.
          waiting = this.waitForCosTurn(orgId, tag);
          waiting.catch(() => undefined);
          this.session(orgId).send('cos', text, tag);
        },
        waitForCos: () => waiting,
        emit: (state) => this.d.emit({ type: 'plugin-action', orgId, state }),
        message: t('cos.msg.applyHqUpdate'),
        cosName: this.session(orgId).cos.speaker,
        recheckMs: this.d.updateRecheckMs,
      });
    } finally {
      this.updating.delete(orgId);
    }
    await this.refreshHealth(orgId, false);
  }

  /**
   * Resolves when the chief of staff turn that handles the message tagged `tag` ends (not an earlier turn: the tag
   * comes back in `TurnResult.sent`, whichever message of the batch it answers), or when a status refresh shows the hq no longer lags. Rejects when the org is
   * removed or the message is dropped (thread stopped). Removes its listeners when done.
   */
  private waitForCosTurn(orgId: OrgId, tag: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cos = this.session(orgId).cos;
      const r = this.runtime(orgId);
      const finish = (err?: Error) => {
        cos.offTurnEnd(onEnd);
        r.hqCurrentWaiters.delete(onCurrent);
        clearInterval(poll);
        if (err) reject(err);
        else resolve();
      };
      const onEnd = (res: TurnResult) => {
        if (res.sent.some((m) => m.tag === tag) && !res.notStarted) finish(); // a message that never started is reported by the poll below as dropped
      };
      const onCurrent = () => finish();
      const poll = setInterval(() => {
        if (!this.registry.get(orgId)) finish(new Error(t('plugin.err.orgGone')));
        else if (!cos.hasTag(tag)) finish(new Error(t('plugin.err.messageDropped', { cosName: cos.speaker })));
      }, this.d.cosPollMs ?? 1000);
      poll.unref?.();
      cos.onTurnEnd(onEnd);
      r.hqCurrentWaiters.add(onCurrent);
    });
  }

  private async pluginAction(orgId: OrgId, action: 'install', fn: (claude: string, hq: string) => Promise<{ ok: boolean; error: string | null }>): Promise<void> {
    const e = this.registry.get(orgId);
    if (!e || !this.claudePath) return;
    this.d.emit({ type: 'plugin-action', orgId, state: { running: true, action, error: null } });
    const res = await fn(this.claudePath, e.path);
    if (res.ok) {
      // Load the new plugin: let turns in flight finish, then restart this org's processes.
      await this.rt.get(orgId)?.session?.restartSessions();
    }
    this.d.emit({ type: 'plugin-action', orgId, state: { running: false, action, error: res.ok ? null : res.error } });
    await this.refreshPrereqs(orgId);
    await this.refreshHealth(orgId, false);
  }

  // ---------- hq health ----------

  async refreshHealth(orgId: OrgId, fetch: boolean): Promise<HealthStatus | null> {
    const e = this.registry.get(orgId);
    if (!e || !isHq(e.path)) return null;
    const r = this.runtime(orgId);
    const p = r.plugin;
    const plugin = !p ? 'unknown' : p.state === 'ok' ? (p.belowMinimum ? 'old' : 'ok') : p.state === 'unknown' ? 'unknown' : 'missing';
    const h = await checkHealth(e.path, {
      plugin,
      pluginMinimum: MIN_PLUGIN_VERSION,
      autoPushFailing: r.pusher?.failing ?? false,
      pushError: r.pusher?.lastError ?? null,
      lastSyncAt: r.lastSyncAt,
      fetch,
      syncing: r.syncing,
    });
    const dropped = droppedRulesBySource(e.path);
    const broad = broadAllowRulesBySource(e.path);
    let health: HealthStatus = dropped.local.length || dropped.project.length ? { ...h, droppedRules: dropped } : h;
    if (broad.local.length || broad.project.length) health = { ...health, broadRules: broad };
    await this.refreshLeftovers();
    const left = this.leftovers.get(orgId) ?? [];
    if (left.length > 0) {
      // A warning, not a problem: only a healthy indicator turns yellow (anything worse keeps its own sentence).
      const warn = health.color === 'green' ? { color: 'yellow' as const, ...(health.syncing ? {} : { sentence: tn('health.yellow.leftover', left.length) }) } : {};
      health = { ...health, ...warn, leftoverProcesses: left.map((l) => ({ pid: l.pid, startedAt: l.startedAt })) };
    }
    if (fetch && h.color === 'green' && !r.lastSyncAt) {
      r.lastSyncAt = new Date().toISOString();
      health = { ...health, lastSyncAt: r.lastSyncAt };
    }
    r.health = health;
    this.d.emit({ type: 'health', orgId, status: health });
    return health;
  }

  async getHealth(orgId: OrgId): Promise<HealthStatus | null> {
    return this.runtime(orgId).health ?? this.refreshHealth(orgId, false);
  }

  /** The "Try again" button: run the automatic push now, then refresh health. */
  async retryPush(orgId: OrgId): Promise<void> {
    const r = this.runtime(orgId);
    await r.pusher?.retryNow();
    await this.refreshHealth(orgId, false);
  }

  /** Chat > New Session: the chief of staff's next message from idle starts a new session. False when one is already requested. */
  newSession(orgId: OrgId): boolean {
    return this.session(orgId).newCosSession();
  }

  /** The "Clean up" button: removes the ignored rules from the org's settings.local.json (only), then refreshes health. */
  async cleanUpIgnoredRules(orgId: OrgId): Promise<number> {
    const e = this.registry.get(orgId);
    if (!e || !isHq(e.path)) throw new Error('Unknown org.');
    const removed = removeDroppedLocalRules(e.path); // throws when the file is missing or not valid JSON
    await this.refreshHealth(orgId, false);
    return removed;
  }

  async sync(orgId: OrgId): Promise<void> {
    const e = this.registry.get(orgId);
    if (!e) return;
    const r = this.runtime(orgId);
    r.syncing = true;
    await this.refreshHealth(orgId, false);
    const res = await gitSync(e.path);
    r.syncing = false;
    if (res.ok) {
      r.lastSyncAt = new Date().toISOString();
      r.pusher?.markSynced();
    } else {
      this.d.emit({ type: 'notice', orgId, text: t('notice.syncFailed', { error: res.error ?? '' }) });
    }
    await this.refreshHealth(orgId, true);
  }

  // ---------- settings (per org) ----------

  getSettings(orgId: OrgId): Settings {
    return this.d.settings.get(orgId, this.hqPathOf(orgId));
  }

  /** The contextual tips that apply to this org now (not dismissed), in display order; empty when none. */
  async getTips(orgId: OrgId): Promise<Tip[]> {
    const hqPath = this.registry.get(orgId)?.path;
    return hqPath ? this.tips.list(orgId, hqPath) : [];
  }

  dismissTip(orgId: OrgId, tipId: string): void {
    if (this.registry.get(orgId)) this.tips.dismiss(orgId, tipId);
  }

  setSettings(orgId: OrgId, patch: SettingsPatch): Settings {
    const s = this.d.settings.set(orgId, this.hqPathOf(orgId), patch);
    this.d.emit({ type: 'settings', orgId, settings: s });
    // The mode of a running chat changes at its next message: show the note in every chat of the org now.
    if (patch.permissionMode !== undefined) this.rt.get(orgId)?.session?.emitThreadStates();
    return s;
  }

  /** Restarts this org's chats once the reply in flight and the queue are done, so new settings take effect. */
  async applySettings(orgId: OrgId): Promise<void> {
    await this.rt.get(orgId)?.session?.restartSessions();
  }

  // ---------- running work (for the run guard) ----------

  /** What runs now in one org, or in every org that has a session (work in other orgs is never listed for an org-scoped action). */
  runningItems(scope: GuardScope): RunningItem[] {
    const ids = scope === 'all' ? [...this.rt.keys()] : [scope];
    const out: RunningItem[] = [];
    for (const id of ids) {
      const session = this.rt.get(id)?.session;
      if (!session) continue;
      out.push(...session.runningItems(this.orgName(id)));
    }
    return out;
  }

  /** Stops one org's running work for an action the user confirmed (see `OrgSession.forceStop`). */
  async forceStop(orgId: OrgId, actionLabel: string): Promise<void> {
    await this.rt.get(orgId)?.session?.forceStop(actionLabel);
  }

  /** Shows that an action waits for this org's work to end: a line in its chief of staff thread and a notice. */
  notePending(orgId: OrgId, text: string): void {
    this.rt.get(orgId)?.session?.noteInCos(text);
    this.d.emit({ type: 'notice', orgId, text: t('guard.pending.notice', { org: this.orgName(orgId), text }) });
  }

  private orgName(orgId: OrgId): string {
    const e = this.registry.get(orgId);
    if (!e) return '';
    return isHq(e.path) ? loadHq(e.path).org.name || path.basename(e.path) : path.basename(e.path);
  }

  /** The org's allow and deny rules for the Settings window. Reads files only: the org need not be active. */
  getPermissionRules(orgId: OrgId): PermissionRules {
    return buildPermissionRules(this.hqPathOf(orgId), this.d.settings.userDenyRules());
  }

  /**
   * Removes one rule saved with "Always allow" (settings.local.json), makes the broker forget the requests it remembered
   * under it for this run, and refreshes the chats' "applies from your next message" note. Returns the lists after.
   */
  removeSavedRule(orgId: OrgId, rule: string): PermissionRules {
    const hqPath = this.hqPathOf(orgId);
    if (typeof rule === 'string' && removeSavedAllowRule(hqPath, rule)) {
      this.d.broker.forgetRule(hqPath, rule);
      this.rt.get(orgId)?.session?.emitThreadStates();
    }
    return this.getPermissionRules(orgId);
  }

  /** App, Claude Code, plugin and org versions for the About section; nothing is fetched. */
  getAbout(orgId: OrgId, appVersion: string): AboutInfo {
    const hqPath = this.hqPathOf(orgId);
    let frameworkVersion: string | null = null;
    try {
      frameworkVersion = parseOrgYaml(fs.readFileSync(path.join(hqPath, 'org.yaml'), 'utf8')).frameworkVersion;
    } catch {
      // no readable org.yaml: unknown
    }
    return buildAbout({ appVersion, prereq: this.prereq, plugin: this.rt.get(orgId)?.plugin ?? null, frameworkVersion, hqPath });
  }

  getDispatches(orgId: OrgId): Dispatch[] {
    return this.session(orgId).dispatches();
  }

  ackDispatches(orgId: OrgId, ids: string[]): void {
    this.session(orgId).ackDispatches(ids);
  }

  /**
   * Connectors per department, the forbidden ones (org.yaml and accounts.local.yaml), the hq's own `.mcp.json` servers and
   * what the org's chats loaded (from their init messages). Reads files only (no write path): the org need not be active;
   * without a live session nothing is loaded yet (`started: false`) and the kept-out servers come from the deny list a new chat would get.
   */
  getConnectors(orgId: OrgId): ConnectorsInfo {
    const hqPath = this.hqPathOf(orgId);
    const info = readConnectors(hqPath);
    const d = sessionDeny(hqPath, this.d.settings.userDenyRules());
    const launch = mcpLaunch(d.deny, d.keptOut);
    const live = this.rt.get(orgId)?.session?.loadedConnectors(d.deny) ?? { started: false, loaded: [] };
    const known = [...live.loaded.map((l) => l.name), ...hqMcpServerNames(hqPath)];
    return {
      ...info,
      forbiddenProblems: d.problems,
      forbiddenWarnings: caseWarnings(d.forbidden, known),
      session: { ...live, keptOut: launch.keptOut, claudeAiOff: launch.claudeAiOff, forbiddenRules: d.forbidden, mcpLocked: d.problems.length > 0 },
    };
  }

  /** The readable body of one initiative's status page; null on any problem (see `readInitiativeStatus`), also for an unknown org. */
  readInitiative(orgId: OrgId, slug: string): string | null {
    const e = this.registry.get(orgId);
    return e ? readInitiativeStatus(e.path, slug) : null;
  }

  /** The hq folder of a known org, null for an unknown one. */
  hqPathFor(orgId: OrgId): string | null {
    return this.registry.get(orgId)?.path ?? null;
  }

  private hqPathOf(orgId: OrgId): string {
    const e = this.registry.get(orgId);
    if (!e) throw new Error('Unknown org.');
    return e.path;
  }
}

export { pluginStatus };
