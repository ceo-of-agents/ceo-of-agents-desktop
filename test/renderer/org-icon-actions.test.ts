import { describe, expect, it, vi } from 'vitest';
import { ICON_SIDE, railMenuItems, railNoticeText, removeOrgIconNotice, setOrgIcon, squareCrop } from '../../src/renderer/org-icon-actions';
import type { OrgIconPick, OrgIconResult } from '../../src/shared/types';

const ok: OrgIconPick = { ok: true, mediaType: 'image/webp', data: 'AAAA' };
const mkApi = (pick: OrgIconPick | null, save: OrgIconResult = { ok: true }) => ({
  pickOrgIcon: vi.fn().mockResolvedValue(pick),
  saveOrgIcon: vi.fn().mockResolvedValue(save),
  removeOrgIcon: vi.fn().mockResolvedValue({ ok: true }),
});

describe('squareCrop', () => {
  it('crops the centre square', () => {
    expect(squareCrop(400, 200)).toEqual({ x: 100, y: 0, side: 200 });
    expect(squareCrop(200, 401)).toEqual({ x: 0, y: 100, side: 200 });
    expect(squareCrop(64, 64)).toEqual({ x: 0, y: 0, side: 64 });
  });
  it('the stored side matches the main process', () => {
    expect(ICON_SIDE).toBe(256);
  });
});

describe('setOrgIcon (shared by Settings and the rail menu)', () => {
  it('cancelled picker: null, nothing rendered or saved', async () => {
    const a = mkApi(null);
    const render = vi.fn();
    expect(await setOrgIcon('o1', render, a)).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(a.saveOrgIcon).not.toHaveBeenCalled();
  });
  it('WebP (or any picked source) is decoded by the renderer, and only its PNG is sent to main', async () => {
    const a = mkApi(ok);
    const render = vi.fn().mockResolvedValue('UE5H');
    expect(await setOrgIcon('o1', render, a)).toEqual({ kind: 'saved' });
    expect(render).toHaveBeenCalledWith('image/webp', 'AAAA');
    expect(a.saveOrgIcon).toHaveBeenCalledWith('o1', 'UE5H');
  });
  it('a pick error is passed on without decoding (not a regular file, too large)', async () => {
    const a = mkApi({ ok: false, error: 'notAFile' });
    const render = vi.fn();
    expect(await setOrgIcon('o1', render, a)).toEqual({ kind: 'error', key: 'orgIcon.error.notAFile' });
    expect(render).not.toHaveBeenCalled();
    expect(await setOrgIcon('o1', render, mkApi({ ok: false, error: 'tooLarge' }))).toEqual({ kind: 'error', key: 'orgIcon.error.tooLarge' });
  });
  it('an image that cannot be decoded: unsupported, nothing saved', async () => {
    const a = mkApi(ok);
    expect(await setOrgIcon('o1', vi.fn().mockResolvedValue(null), a)).toEqual({ kind: 'error', key: 'orgIcon.error.unsupported' });
    expect(a.saveOrgIcon).not.toHaveBeenCalled();
  });
  it('main refusing the PNG shows its error; a throw becomes writeFailed', async () => {
    expect(await setOrgIcon('o1', async () => 'UE5H', mkApi(ok, { ok: false, error: 'unsupported' }))).toEqual({ kind: 'error', key: 'orgIcon.error.unsupported' });
    const a = mkApi(ok);
    a.pickOrgIcon.mockRejectedValue(new Error('ipc'));
    expect(await setOrgIcon('o1', async () => 'UE5H', a)).toEqual({ kind: 'error', key: 'orgIcon.error.writeFailed' });
  });
});

describe('removeOrgIconNotice', () => {
  it('removed, or an error', async () => {
    const a = mkApi(null);
    expect(await removeOrgIconNotice('o1', a)).toEqual({ kind: 'removed' });
    a.removeOrgIcon.mockResolvedValue({ ok: false });
    expect(await removeOrgIconNotice('o1', a)).toEqual({ kind: 'error', key: 'orgIcon.error.removeFailed' });
    a.removeOrgIcon.mockRejectedValue(new Error('ipc'));
    expect(await removeOrgIconNotice('o1', a)).toEqual({ kind: 'error', key: 'orgIcon.error.removeFailed' });
  });
});

describe('rail menu helpers', () => {
  it('"Remove icon" only when the org has an icon', () => {
    expect(railMenuItems(false)).toEqual(['set']);
    expect(railMenuItems(true)).toEqual(['set', 'remove']);
  });
  it('the toast text names the org', () => {
    expect(railNoticeText({ kind: 'saved' }, 'ACME')).toContain('ACME');
    expect(railNoticeText({ kind: 'removed' }, 'ACME')).toContain('ACME');
    expect(railNoticeText({ kind: 'error', key: 'orgIcon.error.notAFile' }, 'ACME')).toMatch(/image file/);
  });
});
