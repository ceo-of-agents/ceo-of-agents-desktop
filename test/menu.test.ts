import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { name: 'CEO of Agents' }, Menu: {} }));

import { buildMenuTemplate } from '../src/main/menu';

describe('application menu', () => {
  it('Close Tab is Cmd+W and sends the close-tab event; the window closes with Cmd+Shift+W', () => {
    const emit = vi.fn();
    const tpl = buildMenuTemplate(emit, true);
    expect(tpl[0].label).toBe('CEO of Agents');
    const file = tpl.find((m) => m.label === 'File');
    const items = file?.submenu as Array<{ label: string; accelerator: string; click: () => void }>;
    const item = items.find((i) => i.label === 'Close Tab')!;
    expect(item).toMatchObject({ label: 'Close Tab', accelerator: 'CmdOrCtrl+W' });
    item.click();
    expect(emit).toHaveBeenCalledWith({ type: 'menu', command: 'close-tab' });
    expect(tpl.some((m) => m.role === 'editMenu')).toBe(true);
    const win = tpl.find((m) => m.role === 'windowMenu');
    const close = (win?.submenu as Array<{ role: string; accelerator?: string }>).find((i) => i.role === 'close');
    expect(close?.accelerator).toBe('CmdOrCtrl+Shift+W');
  });

  it('Org Chart is Cmd+Shift+O and sends the org-chart event; no other item uses that key', () => {
    const emit = vi.fn();
    const tpl = buildMenuTemplate(emit, true);
    const file = tpl.find((m) => m.label === 'File');
    const items = file?.submenu as Array<{ label: string; accelerator: string; click: () => void }>;
    const item = items.find((i) => i.label === 'Org Chart')!;
    expect(item.accelerator).toBe('CmdOrCtrl+Shift+O');
    item.click();
    expect(emit).toHaveBeenCalledWith({ type: 'menu', command: 'org-chart' });
    const accelerators = tpl.flatMap((m) => (Array.isArray(m.submenu) ? (m.submenu as Array<{ accelerator?: string }>).map((i) => i.accelerator) : []));
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+Shift+O')).toHaveLength(1);
  });

  it('Chat > New Session is Cmd+Shift+N, sits between File and Edit and sends the new-session event', () => {
    const emit = vi.fn();
    const tpl = buildMenuTemplate(emit, true);
    const labels = tpl.map((m) => m.label ?? m.role);
    expect(labels.indexOf('Chat')).toBe(labels.indexOf('File') + 1);
    expect(labels.indexOf('editMenu')).toBe(labels.indexOf('Chat') + 1);
    const items = tpl.find((m) => m.label === 'Chat')?.submenu as Array<{ label: string; accelerator: string; click: () => void }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'New Session', accelerator: 'CmdOrCtrl+Shift+N' });
    items[0].click();
    expect(emit).toHaveBeenCalledWith({ type: 'menu', command: 'new-session' });
    const accelerators = tpl.flatMap((m) => (Array.isArray(m.submenu) ? (m.submenu as Array<{ accelerator?: string }>).map((i) => i.accelerator) : []));
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+Shift+N')).toHaveLength(1);
  });

  it('Settings is Cmd+, and sends the settings event; no other item uses that key', () => {
    const emit = vi.fn();
    const tpl = buildMenuTemplate(emit, true);
    const file = tpl.find((m) => m.label === 'File');
    const items = file?.submenu as Array<{ label: string; accelerator: string; click: () => void }>;
    const item = items.find((i) => i.label === 'Settings…')!;
    expect(item.accelerator).toBe('CmdOrCtrl+,');
    item.click();
    expect(emit).toHaveBeenCalledWith({ type: 'menu', command: 'settings' });
    const accelerators = tpl.flatMap((m) => (Array.isArray(m.submenu) ? (m.submenu as Array<{ accelerator?: string }>).map((i) => i.accelerator) : []));
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+,')).toHaveLength(1);
  });

  it('View > Waiting on you: focus view is Cmd+Shift+F, disabled until something waits, and sends the focus-waiting event', () => {
    const emit = vi.fn();
    type Item = { label?: string; accelerator?: string; enabled?: boolean; click?: () => void };
    const view = (tpl: ReturnType<typeof buildMenuTemplate>) => (tpl.find((m) => m.label === 'View')?.submenu as Item[]).find((i) => i.label === 'Waiting on you: focus view')!;
    const off = view(buildMenuTemplate(emit, true));
    expect(off).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+F', enabled: false });
    const on = view(buildMenuTemplate(emit, true, true));
    expect(on.enabled).toBe(true);
    on.click?.();
    expect(emit).toHaveBeenCalledWith({ type: 'menu', command: 'focus-waiting' });
    const tpl = buildMenuTemplate(emit, true, true);
    const accelerators = tpl.flatMap((m) => (Array.isArray(m.submenu) ? (m.submenu as Array<{ accelerator?: string }>).map((i) => i.accelerator) : []));
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+Shift+F')).toHaveLength(1);
  });

  it('Mac app menu: About, Check for Updates…, then the usual items, Quit last; the item calls the injected handler', () => {
    const emit = vi.fn();
    const check = vi.fn();
    const tpl = buildMenuTemplate(emit, true, false, check);
    type Item = { label?: string; role?: string; type?: string; click?: () => void };
    const items = tpl[0].submenu as Item[];
    expect(items.map((i) => i.label ?? i.role ?? i.type)).toEqual(['about', 'Check for Updates…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']);
    items[1].click?.();
    expect(check).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('other platforms get the item under Help', () => {
    const check = vi.fn();
    const tpl = buildMenuTemplate(vi.fn(), false, false, check);
    const help = tpl.find((m) => m.role === 'help');
    (help?.submenu as Array<{ label: string; click: () => void }>)[0].click();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
