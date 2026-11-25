import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, CoaApi } from './shared/types';

// Each API method maps to one ipcMain.handle channel of the same name (see src/main/ipc.ts).
const methods = [
  'listOrgs', 'openOrgDialog', 'activateOrg', 'getOrgView', 'getOrgChart', 'getThread', 'send', 'runCommand', 'cancelCommand', 'getImage', 'getOrgIcon', 'pickOrgIcon', 'saveOrgIcon', 'removeOrgIcon', 'getVoice', 'saveVoice', 'listTabs', 'startTab', 'handOver',
  'closeTab',
  'respondPermission', 'answerQuestion', 'checkPrereqs', 'signIn', 'cancelSignIn', 'installPlugin', 'getAppUpdate', 'updateApp', 'updateOrg', 'openTerminal',
  'applySettings',
  'getHealth', 'sync', 'getSettings', 'setSettings', 'getTips', 'dismissTip', 'setThreadRun', 'openExternal',
  'retryPush', 'newSession', 'cleanUpIgnoredRules', 'stopLeftoverProcess', 'getPermissionRules', 'removeSavedRule', 'getAbout', 'getDispatches', 'ackDispatches', 'getConnectors', 'readInitiative',
  'setupData', 'pickSetupFolder', 'startSetup', 'sendSetup', 'stopSetup', 'finishSetup', 'getSetupThread', 'getSetupState',
  'getUsage', 'refreshUsage', 'setWaitingFocusAvailable',
] as const;

const api: Record<string, unknown> = {};
for (const m of methods) api[m] = (...args: unknown[]) => ipcRenderer.invoke(m, ...args);
api.onEvent = (listener: (event: AppEvent) => void) => {
  const fn = (_e: unknown, event: AppEvent) => listener(event);
  ipcRenderer.on('event', fn);
  return () => ipcRenderer.removeListener('event', fn);
};

contextBridge.exposeInMainWorld('coa', api as unknown as CoaApi);
