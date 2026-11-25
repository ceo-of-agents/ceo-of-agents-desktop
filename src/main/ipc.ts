// IPC handlers: one ipcMain.handle per CoaApi method (see src/preload.ts and src/shared/types.ts).
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { PermissionBroker } from './claude/permissions';
import type { OrgManager } from './org/org-manager';
import type { RunGuard } from './org/run-guard';
import type { SetupManager } from './setup/setup-manager';
import { SETUP_ORG_ID, setupThreadId, type SetupAnswers } from '../shared/setup';
import { t } from '../shared/strings';
import { MAX_ORG_ICON_FILE, readOrgIcon, readOrgIconSource, removeOrgIcon, writeOrgIcon } from './hq/org-icon';
import { readVoice, writeVoice } from './hq/voice';
import { threadKey } from './org/org-session';
import type { AppUpdater } from './system/app-update';
import { SignInFlow } from './system/signin';
import { openTerminal } from './system/terminal';
import { runCommand, sendMessage } from './send';
import type { AppEvent, EffortLevel, FileAttachment, ImageAttachment, OrgIconPick, OrgIconResult, OrgId, PermissionDecision, SettingsPatch, ThreadId, VoiceInfo, VoiceSaveResult } from '../shared/types';

export interface IpcDeps {
  win: () => BrowserWindow | null;
  orgs: OrgManager;
  broker: PermissionBroker;
  emit: (e: AppEvent) => void;
  /** Confirms before an action that would end running work. */
  guard: RunGuard;
  /** The "Create a new org" wizard. */
  setup: SetupManager;
  /** Enables or disables the View menu item of the waiting focus view. */
  setWaitingFocusAvailable?: (available: boolean) => void;
  /** The app's own update. */
  appUpdate: AppUpdater;
}

export function registerIpc(d: IpcDeps): void {
  let signIn: SignInFlow | null = null;
  const h = (name: string, fn: (...args: never[]) => unknown) => ipcMain.handle(name, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args));

  h('listOrgs', () => ({ orgs: d.orgs.summaries(), activeOrgId: d.orgs.defaultOrgId() }));
  h('openOrgDialog', async () => {
    const w = d.win();
    const r = w ? await dialog.showOpenDialog(w, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return d.orgs.addFromFolder(r.filePaths[0]);
  });
  h('activateOrg', (orgId: OrgId) => d.orgs.activate(orgId));
  h('getOrgView', (orgId: OrgId) => d.orgs.view(orgId));
  h('getOrgChart', (orgId: OrgId) => d.orgs.orgChart(orgId));
  h('getThread', (orgId: OrgId, threadId: ThreadId) => {
    const info = d.orgs.session(orgId).getThread(threadId);
    // A reloaded window has lost its permission cards: send the ones still waiting for this thread again.
    setImmediate(() => {
      for (const r of d.broker.pending(threadKey(orgId, threadId))) {
        d.emit({ type: 'permission', request: { requestId: r.requestId, orgId, threadId, toolName: r.toolName, input: r.input, summary: r.summary, rule: r.rule } });
      }
    });
    return info;
  });
  h('send', (orgId: OrgId, threadId: ThreadId, text: string, images?: ImageAttachment[], files?: FileAttachment[]) => sendMessage(d, orgId, threadId, text, images, files));
  h('runCommand', (orgId: OrgId, threadId: ThreadId, command: string) =>
    runCommand(d, orgId, threadId, command, async (c) => {
      const detail = [t('command.confirm.detail', { command: c.command, folder: c.folder, speaker: c.speaker }), c.deniedBy ? t('command.confirm.denied', { rule: c.deniedBy }) : '']
        .filter(Boolean)
        .join('\n\n');
      // Cancel is the default: Enter or Escape never runs the command.
      const opts = { type: 'warning' as const, message: t('command.confirm.message'), detail, buttons: [t('command.confirm.run'), t('command.confirm.cancel')], defaultId: 1, cancelId: 1, noLink: true };
      const w = d.win();
      const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    }),
  );
  h('cancelCommand', (orgId: OrgId, threadId: ThreadId, id: string) => {
    if (typeof id === 'string') d.orgs.session(orgId).cancelCommand(threadId, id);
  });
  h('getOrgIcon', (orgId: OrgId) => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    return hq ? readOrgIcon(hq) : null;
  });
  h('pickOrgIcon', async (orgId: OrgId): Promise<OrgIconPick | null> => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    if (!hq) return { ok: false, error: 'writeFailed' };
    const opts = { properties: ['openFile' as const], filters: [{ name: t('orgIcon.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] };
    const w = d.win();
    const r = w && !w.isDestroyed() ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    // Regular file, size cap and type are checked on the open descriptor; the renderer decodes and resizes (off the main process).
    return readOrgIconSource(r.filePaths[0]);
  });
  h('saveOrgIcon', (orgId: OrgId, png: string): OrgIconResult => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    if (!hq || typeof png !== 'string') return { ok: false, error: 'writeFailed' };
    // The renderer is not trusted: a text over the base64 length of the cap is refused before it is decoded.
    if (png.length > Math.ceil((MAX_ORG_ICON_FILE * 4) / 3) + 4) return { ok: false, error: 'tooLarge' };
    const result = writeOrgIcon(hq, Buffer.from(png, 'base64'));
    if (result.ok) d.orgs.emitOrgs();
    return result;
  });
  h('removeOrgIcon', (orgId: OrgId) => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    if (!hq) return { ok: false };
    const r = removeOrgIcon(hq);
    if (r.ok) d.orgs.emitOrgs();
    return r;
  });
  h('getVoice', (orgId: OrgId): VoiceInfo => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    return hq ? readVoice(hq) : { path: '', exists: false, text: '', version: 'missing', error: 'unreadable' };
  });
  h('saveVoice', (orgId: OrgId, text: string, expectedVersion: string): VoiceSaveResult => {
    const hq = typeof orgId === 'string' ? d.orgs.hqPathFor(orgId) : null;
    return hq && typeof expectedVersion === 'string' ? writeVoice(hq, text, expectedVersion) : { ok: false, error: 'writeFailed' };
  });
  h('getImage', (orgId: OrgId, id: string) => d.orgs.session(orgId).getImage(id));
  h('setThreadRun', (orgId: OrgId, threadId: ThreadId, choice: { model?: string | null; effort?: EffortLevel | null }) =>
    d.orgs.session(orgId).setRun(threadId, choice && typeof choice === 'object' ? choice : {}),
  );
  h('listTabs', (orgId: OrgId) => d.orgs.session(orgId).listTabs());
  h('startTab', (orgId: OrgId, agent: string) => {
    const tab = d.orgs.session(orgId).startTab(agent);
    d.emit({ type: 'tabs', orgId, tabs: d.orgs.session(orgId).listTabs() });
    return tab;
  });
  h('closeTab', (orgId: OrgId, tabId: string) => d.orgs.session(orgId).closeTab(tabId));
  h('handOver', (orgId: OrgId, tabId: string) => d.orgs.session(orgId).handOver(tabId));
  h('respondPermission', (requestId: string, decision: PermissionDecision, rule?: string) => {
    if (!['allow', 'always', 'deny'].includes(decision)) return;
    d.broker.respond(requestId, decision, typeof rule === 'string' ? rule : undefined);
  });
  h('answerQuestion', (requestId: string, answers: Record<string, string>) => {
    if (typeof requestId !== 'string' || !answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
    if (!Object.values(answers).every((v) => typeof v === 'string')) return false;
    return d.broker.answer(requestId, answers);
  });
  h('checkPrereqs', (orgId: OrgId | null) => d.orgs.refreshPrereqs(orgId));
  h('signIn', () => {
    const claude = d.orgs.lastPrereq()?.claude.path;
    if (!claude || signIn) return;
    const flow = new SignInFlow();
    signIn = flow;
    flow.on('state', (state) => d.emit({ type: 'sign-in', state }));
    flow.on('done', () => {
      if (signIn === flow) signIn = null;
      const active = d.orgs.registry.activeId();
      void d.orgs.refreshPrereqs(active);
    });
    flow.start(claude);
  });
  h('cancelSignIn', () => {
    signIn?.cancel();
    signIn = null;
  });
  // Actions that restart an org's chats are confirmed while that org has work running (never mentioning other orgs).
  h('installPlugin', async (orgId: OrgId) => {
    await d.guard.run(orgId, t('guard.action.install'), () => d.orgs.installPlugin(orgId));
  });
  h('updateOrg', async (orgId: OrgId) => {
    await d.guard.run(orgId, t('guard.action.update'), () => d.orgs.updateOrg(orgId));
  });
  h('openTerminal', () => openTerminal());
  h('getHealth', (orgId: OrgId) => d.orgs.getHealth(orgId));
  h('getAppUpdate', (force?: boolean) => d.appUpdate.check(force === true));
  h('updateApp', () => d.appUpdate.update());
  h('getUsage', () => d.orgs.usage.get());
  h('refreshUsage', () => d.orgs.usageRefresh.refresh());
  h('retryPush', (orgId: OrgId) => d.orgs.retryPush(orgId));
  h('cleanUpIgnoredRules', (orgId: OrgId) => d.orgs.cleanUpIgnoredRules(orgId));
  h('stopLeftoverProcess', (orgId: OrgId, pid: number) => (typeof orgId === 'string' && Number.isInteger(pid) ? d.orgs.stopLeftoverProcess(orgId, pid) : false));
  h('newSession', (orgId: OrgId) => d.orgs.newSession(orgId));
  h('sync', (orgId: OrgId) => d.orgs.sync(orgId));
  h('getSettings', (orgId: OrgId) => d.orgs.getSettings(orgId));
  h('setSettings', (orgId: OrgId, patch: SettingsPatch) => d.orgs.setSettings(orgId, patch && typeof patch === 'object' ? patch : {}));
  h('getTips', (orgId: OrgId) => (typeof orgId === 'string' ? d.orgs.getTips(orgId) : []));
  h('dismissTip', (orgId: OrgId, tipId: string) => {
    if (typeof orgId === 'string' && typeof tipId === 'string') d.orgs.dismissTip(orgId, tipId);
  });
  h('applySettings', async (orgId: OrgId) => {
    await d.guard.run(orgId, t('guard.action.apply'), () => d.orgs.applySettings(orgId));
  });
  h('getPermissionRules', (orgId: OrgId) => d.orgs.getPermissionRules(orgId));
  h('removeSavedRule', (orgId: OrgId, rule: string) => d.orgs.removeSavedRule(orgId, rule));
  h('getAbout', (orgId: OrgId) => d.orgs.getAbout(orgId, app.getVersion()));
  h('getDispatches', (orgId: OrgId) => d.orgs.getDispatches(orgId));
  h('ackDispatches', (orgId: OrgId, ids: string[]) => {
    if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) d.orgs.ackDispatches(orgId, ids);
  });
  h('getConnectors', (orgId: OrgId) => d.orgs.getConnectors(orgId));
  h('setupData', () => d.setup.data());
  h('pickSetupFolder', () => d.setup.pickFolder(d.win()));
  h('startSetup', (answers: SetupAnswers, folder: string) =>
    answers && typeof answers === 'object' && typeof folder === 'string' ? d.setup.start(answers, folder) : { error: t('setup.err.noRun') },
  );
  h('sendSetup', (runId: string, text: string) => {
    if (typeof runId === 'string' && typeof text === 'string') d.setup.send(runId, text);
  });
  h('stopSetup', (runId: string) => (typeof runId === 'string' ? d.setup.stop(runId) : undefined));
  h('finishSetup', (runId: string) => (typeof runId === 'string' ? d.setup.finish(runId) : null));
  h('getSetupThread', (runId: string) => {
    if (typeof runId !== 'string') return null;
    const info = d.setup.thread(runId);
    // A reloaded window has lost its permission cards: send the ones still waiting for this run again.
    if (info) {
      setImmediate(() => {
        for (const r of d.broker.pending(threadKey(SETUP_ORG_ID, setupThreadId(runId)))) {
          d.emit({ type: 'permission', request: { requestId: r.requestId, orgId: SETUP_ORG_ID, threadId: setupThreadId(runId), toolName: r.toolName, input: r.input, summary: r.summary, rule: r.rule } });
        }
      });
    }
    return info;
  });
  h('getSetupState', (runId: string) => (typeof runId === 'string' ? d.setup.status(runId) : null));
  h('setWaitingFocusAvailable', (available: boolean) => d.setWaitingFocusAvailable?.(available === true));
  h('readInitiative', (orgId: OrgId, slug: string) => d.orgs.readInitiative(orgId, slug));
  h('openExternal', (url: string) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
}
