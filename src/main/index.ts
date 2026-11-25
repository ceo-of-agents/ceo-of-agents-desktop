// App entry. The main process is the supervisor: it owns every child process; the renderer only calls window.coa.
import { app, BrowserWindow, dialog, Notification, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEV } from './config';
import { PermissionBroker, defaultSocketPath } from './claude/permissions';
import { questionNotice } from './claude/question-notice';
import { ProcessLedger, installSignalHandlers, trackedSpawner } from './claude/process-ledger';
import { spawnProcess } from './system/exec';
import { AppUpdater } from './system/app-update';
import { OrgManager } from './org/org-manager';
import { RunGuard, choiceAt, guardButtons } from './org/run-guard';
import { safeCloseCheck } from './org/close-check';
import { QuitCoordinator } from './quit';
import { SetupManager } from './setup/setup-manager';
import { SETUP_ORG_ID } from '../shared/setup';
import { SettingsStore } from './settings';
import { registerIpc } from './ipc';
import { setAppMenu, setWaitingFocusAvailable } from './menu';
import { t } from '../shared/strings';
import type { AppEvent, PermissionRequest } from '../shared/types';

if (DEV.userData) app.setPath('userData', DEV.userData);
// The same name package.json productName gives: the data folder (derived from the app name) must not move.
app.setName('CEO of Agents');

// One app per data folder: a second instance would show the first one's live chats as leftovers. Quit at once, and bring the first window forward.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

// Every `claude -p` this app starts is recorded here: stopped when the app ends by any way it can see, found at the next start when it cannot.
const ledger = new ProcessLedger({ file: path.join(app.getPath('userData'), 'claude-processes.json') });
installSignalHandlers(ledger, (code) => app.exit(code));
// Last safety net: nothing is left behind when the app goes down (no-op when every child already exited).
app.on('will-quit', () => ledger.killAllSync('SIGTERM'));

let win: BrowserWindow | null = null;
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
const emit = (e: AppEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send('event', e);
};

async function main(): Promise<void> {
  await app.whenReady();
  // Dev mode runs inside Electron.app: show our icon in the Dock. A packaged app gets it from its bundle.
  try {
    app.dock?.setIcon(path.join(__dirname, 'icon-1024.png'));
  } catch {
    // the icon is cosmetic
  }
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore({ dataDir });
  const broker = new PermissionBroker({ userDeny: () => settings.userDenyRules() });
  await broker.start(defaultSocketPath());

  // Confirms before an action ends running work (see org/run-guard.ts). Filled in below, once the orgs exist.
  let guard: RunGuard | null = null;
  const serverScript = path.join(__dirname, 'permission-server.js');
  const notify = (title: string, body: string): void => {
    if (Notification.isSupported() && !(win && win.isFocused())) new Notification({ title, body }).show();
  };
  const orgs = new OrgManager({
    dataDir,
    settings,
    broker,
    ledger,
    serverScript,
    nodePath: process.execPath,
    emit,
    onRunningChange: () => guard?.changed(),
    notify,
  });

  // The "Create a new org" wizard: its own session in the new org's folder (see setup/setup-manager.ts).
  const setup = new SetupManager({
    dataDir,
    broker,
    serverScript,
    nodePath: process.execPath,
    emit,
    claudePath: () => orgs.claudeBinary(),
    // The wizard's process is in the ledger too: stopped when the app ends, whatever way.
    spawner: (cmd, args, opts) => trackedSpawner(ledger, spawnProcess, { orgId: SETUP_ORG_ID, hqPath: String(opts.cwd ?? '') })(cmd, args, opts),
    canStart: () => orgs.canStart(),
    addFromFolder: (dir) => orgs.addFromFolder(dir),
    onRunningChange: () => guard?.changed(),
  });

  broker.on('request', (r: { requestId: string; threadKey: string; toolName: string; input: unknown; summary: string; rule: string }) => {
    const { orgId, threadId } = OrgManager.parseThreadKey(r.threadKey);
    const request: PermissionRequest = { requestId: r.requestId, orgId, threadId, toolName: r.toolName, input: r.input, summary: r.summary, rule: r.rule };
    emit({ type: 'permission', request });
    // The notice never holds the question: a notification can show on a locked screen.
    const notice = questionNotice(r, orgs.summaries().find((x) => x.id === orgId)?.name);
    if (notice) notify(notice.title, notice.body);
  });

  broker.on('resolved', (requestId: string) => emit({ type: 'permission-resolved', requestId }));

  guard = new RunGuard({
    items: (scope) => [...orgs.runningItems(scope), ...(scope === 'all' ? setup.runningItems() : [])],
    ask: async (text) => {
      const opts = { type: 'warning' as const, message: text.message, detail: text.detail, buttons: guardButtons(), defaultId: 0, cancelId: 2 };
      const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return choiceAt(r.response);
    },
    forceStop: (orgId, label) => (orgId === SETUP_ORG_ID ? setup.shutdown() : orgs.forceStop(orgId, label)),
    notePending: (orgId, text) => (orgId === SETUP_ORG_ID ? emit({ type: 'notice', orgId: null, text }) : orgs.notePending(orgId, text)),
  });
  const runGuard = guard;

  // The app's own update (system/app-update.ts): the button stages it, the install runs when the app exits.
  // `quit` is created below; the button only works once the window is up.
  let quitRequest: () => Promise<boolean> = async () => false;
  const appUpdate = new AppUpdater({
    packaged: app.isPackaged,
    version: app.getVersion(),
    execPath: process.execPath,
    pid: process.pid,
    emit: (status) => emit({ type: 'app-update', status }),
    requestQuit: () => quitRequest(),
  });
  void appUpdate.check();
  setInterval(() => void appUpdate.check(), 60 * 60 * 1000).unref();

  // The menu's "Check for Updates…": forced check, the result in a native dialog on the main window.
  const checkForUpdatesDialog = async (): Promise<void> => {
    const show = (opts: Electron.MessageBoxOptions) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    const r = await appUpdate.checkNow();
    if (r.kind === 'upToDate') await show({ type: 'info', message: t('appUpdate.check.upToDate'), detail: t('appUpdate.check.upToDateDetail', { current: r.current }) });
    else if (r.kind === 'available') {
      const a = await show({ type: 'info', message: t('appUpdate.check.available', { latest: r.latest }), detail: t('appUpdate.check.availableDetail', { current: r.current }), buttons: [t('appUpdate.check.update'), t('appUpdate.check.later')], defaultId: 0, cancelId: 1, noLink: true });
      if (a.response === 0) void appUpdate.update();
    } else if (r.kind === 'failed') await show({ type: 'warning', message: t('appUpdate.check.failed'), detail: r.reason });
    else if (r.kind === 'dev') await show({ type: 'info', message: t('appUpdate.check.dev') });
    else await show({ type: 'info', message: t('appUpdate.check.busy') });
  };

  registerIpc({ win: () => win, orgs, broker, emit, guard: runGuard, setup, setWaitingFocusAvailable, appUpdate });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'CEO of Agents',
    backgroundColor: '#0F172A',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  // All state lives in the main process: if the renderer dies, note why and reload it.
  win.webContents.on('render-process-gone', (_e, details) => {
    const line = `${new Date().toISOString()} renderer gone: ${details.reason} (exit ${details.exitCode})\n`;
    console.error(line.trim());
    try {
      fs.appendFileSync(path.join(dataDir, 'app.log'), line);
    } catch {
      // logging is best effort
    }
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  setAppMenu(emit, () => void checkForUpdatesDialog());
  await orgs.init();
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Department chats that have not handed over: hand over or close quietly (true: go on, false: the user cancelled).
  const handoverCheck = async (): Promise<boolean> =>
    (await safeCloseCheck({
      chats: () => orgs.liveSessions().flatMap((o) => o.session.listTabs().map((tab) => ({ orgId: o.orgId, orgName: o.orgName, cosName: o.cosName, tab, busy: o.session.isTabBusy(tab.tabId) }))),
      ask: async (d) => {
        const options = { type: 'warning' as const, message: d.message, detail: d.detail, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, noLink: true };
        const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        return r.response;
      },
      progress: async (d, signal) => {
        // The box closes when `signal` aborts (the wait is over); either way it behaves as cancelled, which closeCheck ignores by then.
        const options = { type: 'info' as const, message: d.message, detail: d.detail, buttons: [d.cancel], defaultId: 0, cancelId: 0, noLink: true, signal };
        if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options);
        else await dialog.showMessageBox(options);
        return 'cancel' as const;
      },
      handOver: (orgId, tabId) => orgs.session(orgId).handOver(tabId),
      closeQuiet: (orgId, tabId) => orgs.session(orgId).closeTab(tabId, { passNote: false }),
      failed: (orgId, text) => {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
        }
        emit({ type: 'notice', orgId, text });
      },
    })) === 'proceed';

  // Cmd+Q, the last window's close button and macOS shutdown all go through one coordinator (src/main/quit.ts):
  // the handover check, then the run guard, then one shutdown.
  const quit = new QuitCoordinator({
    handoverCheck,
    guard: runGuard,
    label: t('guard.action.quit'),
    pendingText: t('guard.pending.quit'),
    forceStopAll: async () => {
      const label = t('guard.action.shutdown');
      for (const id of new Set(orgs.runningItems('all').map((i) => i.orgId))) await orgs.forceStop(id, label);
      await setup.shutdown();
    },
    shutdown: () => Promise.all([orgs.shutdown(), setup.shutdown(), broker.stop()]).then(() => undefined),
    exit: () => {
      appUpdate.installAtExit(systemShutdown);
      app.quit();
    },
  });
  quitRequest = () => quit.request();
  let systemShutdown = false;
  powerMonitor.on('shutdown', () => {
    systemShutdown = true;
    quit.systemShutdown();
  });
  app.on('before-quit', (e) => {
    if (quit.allowQuit) return;
    e.preventDefault();
    void quit.request();
  });
  // Ask while the window still exists, so Cancel keeps it open.
  win.on('close', (e) => {
    if (quit.allowQuit) return;
    e.preventDefault();
    void quit.request();
  });
}

app.on('window-all-closed', () => app.quit());
if (gotSingleInstanceLock) {
  main().catch((e) => {
    console.error(e);
    ledger.close();
    ledger.killAllSync('SIGTERM');
    app.exit(1);
  });
}
