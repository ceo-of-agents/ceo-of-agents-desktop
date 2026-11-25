// The application menu. Cmd+W closes the selected department tab (the renderer decides), so the window's own
// close moves to Cmd+Shift+W. Cmd+Shift+O toggles the Org chart view (it is not a tab), View > Waiting on you: focus view (Cmd+Shift+F) opens the focus view of the waiting items (enabled only when something waits), Cmd+, opens Settings. Chat > New Session (Cmd+Shift+N) asks for a new chief of staff session. The Edit menu is needed for copy and paste.
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { t } from '../shared/strings';
import type { AppEvent } from '../shared/types';

export function buildMenuTemplate(
  emit: (e: AppEvent) => void,
  isMac = process.platform === 'darwin',
  focusAvailable = false,
  onCheckForUpdates: () => void = () => undefined,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const checkItem: MenuItemConstructorOptions = { label: t('menu.checkForUpdates'), click: () => onCheckForUpdates() };
  // The app menu is spelled out (not `role: 'appMenu'`) to add "Check for Updates…" after About; Quit stays the quit role (app.quit, which `before-quit` in index.ts routes through the usual quit path).
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [{ role: 'about' }, checkItem, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    });
  }
  template.push(
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => emit({ type: 'menu', command: 'settings' }) },
        { label: t('menu.orgChart'), accelerator: 'CmdOrCtrl+Shift+O', click: () => emit({ type: 'menu', command: 'org-chart' }) },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: () => emit({ type: 'menu', command: 'close-tab' }) },
      ],
    },
    {
      label: t('menu.chat'),
      submenu: [{ label: t('menu.newSession'), accelerator: 'CmdOrCtrl+Shift+N', click: () => emit({ type: 'menu', command: 'new-session' }) }],
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.focusWaiting'), accelerator: 'CmdOrCtrl+Shift+F', enabled: focusAvailable, click: () => emit({ type: 'menu', command: 'focus-waiting' }) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' }],
    },
  );
  if (!isMac) template.push({ role: 'help', submenu: [checkItem] });
  return template;
}

let emitter: ((e: AppEvent) => void) | null = null;
let focusAvailable = false;
let checkHandler: () => void = () => undefined;

const rebuild = () => {
  if (emitter) Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(emitter, process.platform === 'darwin', focusAvailable, checkHandler)));
};

export function setAppMenu(emit: (e: AppEvent) => void, onCheckForUpdates: () => void = () => undefined): void {
  emitter = emit;
  checkHandler = onCheckForUpdates;
  rebuild();
}

/** Enables or disables View > Waiting on you: focus view (no org open, or nothing waiting). Rebuilds the menu only when the value changes. */
export function setWaitingFocusAvailable(available: boolean): void {
  if (available === focusAvailable) return;
  focusAvailable = available;
  rebuild();
}
