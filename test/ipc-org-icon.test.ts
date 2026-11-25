// The org icon IPC handlers: main-side picker (regular file, size, type), validated save of the renderer's PNG, refresh event. Electron is a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());
const dialogStub = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: dialogStub,
  shell: {},
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) },
}));
import { registerIpc } from '../src/main/ipc';
import { MAX_ORG_ICON_FILE, MAX_ORG_ICON_UPLOAD, ORG_ICON_SIZE } from '../src/main/hq/org-icon';

const call = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args) as Promise<unknown>;
const SRC = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const pngOf = (w: number, h: number, extra = 0): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra)]);
};
const PNG = pngOf(ORG_ICON_SIZE, ORG_ICON_SIZE, 8);
const b64 = (b: Buffer) => b.toString('base64');

let tmp: string;
let hq: string;
let emitOrgs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers.clear();
  dialogStub.showOpenDialog.mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-ipc-icon-'));
  hq = path.join(tmp, 'hq');
  fs.mkdirSync(path.join(hq, 'company'), { recursive: true });
  emitOrgs = vi.fn();
  const orgs = { hqPathFor: (id: string) => (id === 'o1' ? hq : null), emitOrgs };
  registerIpc({ win: () => null, orgs: orgs as never, broker: {} as never, emit: () => undefined, guard: {} as never, setup: {} as never, appUpdate: {} as never });
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

const pick = (name: string, content: Buffer | string) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, content);
  dialogStub.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [f] });
};

describe('pickOrgIcon (reads the source for the renderer)', () => {
  it('cancelled: null, nothing written, no event', async () => {
    dialogStub.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await call('pickOrgIcon', 'o1')).toBeNull();
    expect(fs.existsSync(path.join(hq, 'company', 'icon.png'))).toBe(false);
    expect(emitOrgs).not.toHaveBeenCalled();
  });
  it('a picked image: its bytes and type come back, nothing is written yet', async () => {
    pick('photo.jpg', SRC);
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: true, mediaType: 'image/jpeg', data: b64(SRC) });
    expect(fs.existsSync(path.join(hq, 'company', 'icon.png'))).toBe(false);
    expect(emitOrgs).not.toHaveBeenCalled();
    const opts = dialogStub.showOpenDialog.mock.calls[0][0] as { properties: string[]; filters: Array<{ extensions: string[] }> };
    expect(opts.properties).toEqual(['openFile']);
    expect(opts.filters[0].extensions).toEqual(['png', 'jpg', 'jpeg', 'webp']);
  });
  it('a WebP is accepted as a source', async () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
    pick('photo.webp', webp);
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: true, mediaType: 'image/webp', data: b64(webp) });
  });
  it('a file over the cap: tooLarge, without reading it', async () => {
    const f = path.join(tmp, 'big.png');
    fs.closeSync(fs.openSync(f, 'w'));
    fs.truncateSync(f, MAX_ORG_ICON_UPLOAD + 1);
    dialogStub.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [f] });
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: false, error: 'tooLarge' });
  });
  it('a FIFO chosen in the dialog is refused with notAFile and never read', async () => {
    const fifo = path.join(tmp, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    dialogStub.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [fifo] });
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: false, error: 'notAFile' });
  });
  it('a folder chosen in the dialog: notAFile', async () => {
    dialogStub.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [tmp] });
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: false, error: 'notAFile' });
  });
  it('not an image: unsupported', async () => {
    pick('notes.png', 'plain text');
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: false, error: 'unsupported' });
  });
  it('an unreadable file: writeFailed', async () => {
    dialogStub.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(tmp, 'gone.png')] });
    expect(await call('pickOrgIcon', 'o1')).toEqual({ ok: false, error: 'writeFailed' });
  });
  it('an unknown or invalid org: writeFailed, no picker', async () => {
    expect(await call('pickOrgIcon', 'nope')).toEqual({ ok: false, error: 'writeFailed' });
    expect(await call('pickOrgIcon', 42)).toEqual({ ok: false, error: 'writeFailed' });
    expect(dialogStub.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('saveOrgIcon (validates what the renderer sends)', () => {
  it('a 256 px PNG: written, orgs refreshed, getOrgIcon returns the data URL', async () => {
    expect(await call('saveOrgIcon', 'o1', b64(PNG))).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(hq, 'company', 'icon.png'))).toEqual(PNG);
    expect(emitOrgs).toHaveBeenCalledTimes(1);
    expect(await call('getOrgIcon', 'o1')).toBe(`data:image/png;base64,${b64(PNG)}`);
  });
  it('not a PNG, wrong dimensions or an odd payload: refused, nothing written, no event', async () => {
    for (const bad of [b64(SRC), b64(pngOf(512, 512)), b64(pngOf(256, 100)), '', 'not base64 at all!!']) {
      expect(await call('saveOrgIcon', 'o1', bad)).toEqual({ ok: false, error: 'unsupported' });
    }
    for (const bad of [42, null, undefined, {}]) expect(await call('saveOrgIcon', 'o1', bad)).toEqual({ ok: false, error: 'writeFailed' });
    expect(fs.existsSync(path.join(hq, 'company', 'icon.png'))).toBe(false);
    expect(emitOrgs).not.toHaveBeenCalled();
  });
  it('over the cap: tooLarge, refused before it is decoded', async () => {
    expect(await call('saveOrgIcon', 'o1', b64(pngOf(ORG_ICON_SIZE, ORG_ICON_SIZE, MAX_ORG_ICON_FILE)))).toEqual({ ok: false, error: 'tooLarge' });
    expect(await call('saveOrgIcon', 'o1', 'A'.repeat(MAX_ORG_ICON_FILE * 2))).toEqual({ ok: false, error: 'tooLarge' });
    expect(fs.existsSync(path.join(hq, 'company', 'icon.png'))).toBe(false);
  });
  it('an unknown or invalid org: writeFailed', async () => {
    expect(await call('saveOrgIcon', 'nope', b64(PNG))).toEqual({ ok: false, error: 'writeFailed' });
    expect(await call('saveOrgIcon', 42, b64(PNG))).toEqual({ ok: false, error: 'writeFailed' });
  });
});

describe('removeOrgIcon and getOrgIcon', () => {
  it('removes the file and refreshes the orgs', async () => {
    await call('saveOrgIcon', 'o1', b64(PNG));
    emitOrgs.mockClear();
    expect(await call('removeOrgIcon', 'o1')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(hq, 'company', 'icon.png'))).toBe(false);
    expect(emitOrgs).toHaveBeenCalledTimes(1);
    expect(await call('getOrgIcon', 'o1')).toBeNull();
  });
  it('unknown org: ok false (remove), null (get)', async () => {
    expect(await call('removeOrgIcon', 'nope')).toEqual({ ok: false });
    expect(await call('getOrgIcon', 'nope')).toBeNull();
    expect(await call('getOrgIcon', undefined)).toBeNull();
  });
});
