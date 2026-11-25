// A full CoaApi backed by a scene (see scenes.ts). Reads return the scene's data; writes are no-ops that resolve.
// Typed against src/shared/types.ts: a change of the contract shows up here as a type error.
import type { AboutInfo, AppEvent, CoaApi, ConnectorsInfo, OrgChart, OrgChartLive, OrgView, PermissionRules, ThreadId, ThreadInfo } from '../../src/shared/types';
import type { Scene } from './scenes';
import { EMPTY_FACTS } from '../../src/shared/setup';
import { SETUP_DATA_SAMPLE } from './setup-sample';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** The mock plus `emit`: a scene's `emit` step sends one more event to the renderer after the steps before it. */
export type MockApi = CoaApi & { emit(event: AppEvent): void };

export function createMockApi(scene: Scene, eventDelayMs = 500): MockApi {
  const s = scene.state;
  const listeners = new Set<(event: AppEvent) => void>();
  let scheduled = false;

  const schedule = () => {
    if (scheduled || !scene.events?.length) return;
    scheduled = true;
    setTimeout(() => {
      for (const e of scene.events ?? []) for (const l of [...listeners]) l(e);
    }, eventDelayMs);
  };

  const view = (orgId: string): OrgView | null => s.views[orgId] ?? null;
  const stub = (orgId: string, threadId: ThreadId): ThreadInfo => ({
    orgId, threadId, busy: false, handoffsWaiting: 0, title: '', speaker: '', entries: [], streaming: '',
  });
  const done = () => Promise.resolve();
  const rulesOf = (orgId: string): PermissionRules => s.rules?.[orgId] ?? { hqAllow: [], savedAllow: [], deny: [] };
  const emptyConnectors: ConnectorsInfo = {
    departments: [], forbidden: [], forbiddenLocal: [], forbiddenProblems: [], forbiddenWarnings: [], available: [], notGrantable: [],
    session: { started: false, loaded: [], keptOut: [], claudeAiOff: false, forbiddenRules: [], mcpLocked: false }, error: null,
  };
  const defaultAbout = (orgId: string): AboutInfo => ({
    appVersion: '0.1.0', claudeVersion: s.prereq.claude.version, claudeRange: s.prereq.claude.range, pluginInstalled: s.prereq.plugin?.installed ?? null,
    pluginLatest: s.prereq.plugin?.latest ?? null, frameworkVersion: view(orgId)?.frameworkVersion ?? null, hqPath: `/tmp/${orgId}-hq`,
  });

  const api: MockApi = {
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
    listOrgs: () => (s.hang?.listOrgs ? never() : Promise.resolve({ orgs: s.orgs, activeOrgId: s.activeOrgId })),
    getUsage: () => Promise.resolve(s.usage ?? null),
    refreshUsage: () => Promise.resolve('ok' as const),
    openOrgDialog: () => Promise.resolve(null),
    activateOrg: (orgId) => (s.hang?.activateOrg ? never() : Promise.resolve(view(orgId))),
    getOrgView: (orgId) => Promise.resolve(view(orgId)),
    getOrgChart: (orgId) => Promise.resolve(s.charts?.[orgId] ?? never<{ chart: OrgChart; live: OrgChartLive }>()),
    getThread: (orgId, threadId) => Promise.resolve(s.threads[`${orgId}|${threadId}`] ?? stub(orgId, threadId)),
    send: done,
    runCommand: () => Promise.resolve(false),
    cancelCommand: done,
    getImage: (_orgId, id) => Promise.resolve(s.images?.[id] ?? null),
    getOrgIcon: (orgId) => Promise.resolve(s.orgIcons?.[orgId] ?? null),
    pickOrgIcon: () => Promise.resolve(null),
    saveOrgIcon: () => Promise.resolve({ ok: true }),
    removeOrgIcon: () => Promise.resolve({ ok: true }),
    getVoice: () => Promise.resolve({ path: 'company/ceo-voice.md', exists: false, text: '', version: 'missing' }),
    saveVoice: () => Promise.resolve({ ok: true as const, version: 'mock' }),
    listTabs: (orgId) => Promise.resolve(s.tabs[orgId] ?? []),
    closeTab: done,
    startTab: (orgId, agent) => Promise.reject(new Error(`mock: startTab(${orgId}, ${agent}) is not available`)),
    handOver: done,
    respondPermission: done,
    answerQuestion: () => Promise.resolve(true),
    checkPrereqs: () => Promise.resolve(s.prereq),
    signIn: done,
    cancelSignIn: done,
    installPlugin: done,
    getAppUpdate: () => Promise.resolve({ state: 'idle', current: '0.0.0', latest: null, error: null }),
    updateApp: done,
    updateOrg: done,
    openTerminal: done,
    getHealth: () => Promise.resolve(s.health),
    retryPush: done,
    newSession: () => Promise.resolve(true),
    cleanUpIgnoredRules: () => Promise.resolve(0),
    stopLeftoverProcess: () => Promise.resolve(true),
    sync: done,
    setThreadRun: (orgId, threadId) => Promise.resolve(s.threads[`${orgId}|${threadId}`] ?? null),
    getTips: () => Promise.resolve(s.tip ? [s.tip] : []),
    dismissTip: done,
    getSettings: (orgId) => Promise.resolve(s.settingsByOrg?.[orgId] ?? s.settings),
    setSettings: (orgId) => Promise.resolve(s.settingsByOrg?.[orgId] ?? s.settings),
    applySettings: done,
    getPermissionRules: (orgId) => Promise.resolve(rulesOf(orgId)),
    removeSavedRule: (orgId, rule) => {
      const r = rulesOf(orgId);
      return Promise.resolve({ ...r, savedAllow: r.savedAllow.filter((x) => x.rule !== rule) });
    },
    getAbout: (orgId) => Promise.resolve(s.about?.[orgId] ?? defaultAbout(orgId)),
    getConnectors: (orgId) => Promise.resolve(s.connectors?.[orgId] ?? emptyConnectors),
    readInitiative: (orgId, slug) => Promise.resolve(s.initiativeFiles?.[`${orgId}|${slug}`] ?? null),
    openExternal: done,
    setupData: () => Promise.resolve(s.setup?.dataError ? { error: s.setup.dataError } : SETUP_DATA_SAMPLE),
    pickSetupFolder: () => Promise.resolve(s.setup?.pick ?? { path: '/Users/me/Orgs/acme-hq', ok: true, entries: [] }),
    startSetup: () => Promise.resolve({ runId: 'r1' }),
    sendSetup: done,
    stopSetup: done,
    finishSetup: () => Promise.resolve(null),
    getSetupThread: (runId) => Promise.resolve(s.threads[`setup|setup:${runId}`] ?? stub('setup', `setup:${runId}`)),
    getSetupState: (runId) => Promise.resolve({ runId, busy: false, exited: false, hqReady: false, facts: EMPTY_FACTS, answersFile: '/tmp/coa-setup-x/answers.yaml', error: null }),
    setWaitingFocusAvailable: done,
    getDispatches: (orgId) => Promise.resolve(s.dispatches?.[orgId] ?? []),
    ackDispatches: done,
    onEvent: (listener) => {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return api;
}
