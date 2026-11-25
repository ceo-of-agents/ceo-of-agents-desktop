// Setting and removing an org's icon, shared by Settings > General and the rail's right-click menu. The picked image is
// decoded and resized here, in the renderer (createImageBitmap decodes off the main thread, and Chromium reads WebP where
// Electron's nativeImage does not); the main process only reads the file, then validates and writes the PNG it gets back.
import { t } from '../shared/strings';
import type { CoaApi, ImageMediaType, OrgIconPick } from '../shared/types';
import { api } from './api';
import { orgIconNotice, type OrgIconNotice } from './settings-logic';

/** Side of the stored icon, in pixels. Main refuses any other size (`ORG_ICON_SIZE` in `main/hq/org-icon.ts`). */
export const ICON_SIDE = 256;
/** A source with more pixels than this is refused before it is drawn (a decompression bomb inside the 10 MB cap). */
export const MAX_SOURCE_PIXELS = 100_000_000;

/** The centre square of a width x height image: where to crop before resizing. */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** Turns the picked image (base64) into the base64 of a centre-cropped ICON_SIDE square PNG; null when it cannot be decoded. */
export type IconRenderer = (mediaType: ImageMediaType, data: string) => Promise<string | null>;

/** Production renderer: createImageBitmap + canvas. */
export const renderIconPng: IconRenderer = async (mediaType, data) => {
  let bitmap: ImageBitmap | null = null;
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
    const { width, height } = bitmap;
    if (width <= 0 || height <= 0 || width * height > MAX_SOURCE_PIXELS) return null;
    const crop = squareCrop(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIDE;
    canvas.height = ICON_SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, ICON_SIDE, ICON_SIDE);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    const out = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return btoa(text);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
};

type IconApi = Pick<CoaApi, 'pickOrgIcon' | 'saveOrgIcon' | 'removeOrgIcon'>;

/** Pick, decode and save. Null when the picker was cancelled; otherwise what to tell the user. Never throws. */
export async function setOrgIcon(orgId: string, render: IconRenderer = renderIconPng, a: IconApi = api()): Promise<OrgIconNotice | null> {
  try {
    const pick: OrgIconPick | null = await a.pickOrgIcon(orgId);
    if (!pick) return null;
    if (!pick.ok) return orgIconNotice(pick);
    const png = await render(pick.mediaType, pick.data);
    if (!png) return orgIconNotice({ ok: false, error: 'unsupported' });
    return orgIconNotice(await a.saveOrgIcon(orgId, png));
  } catch {
    return { kind: 'error', key: 'orgIcon.error.writeFailed' };
  }
}

/** Remove the icon. Never throws. */
export async function removeOrgIconNotice(orgId: string, a: IconApi = api()): Promise<OrgIconNotice> {
  try {
    return (await a.removeOrgIcon(orgId)).ok ? { kind: 'removed' } : { kind: 'error', key: 'orgIcon.error.removeFailed' };
  } catch {
    return { kind: 'error', key: 'orgIcon.error.removeFailed' };
  }
}

/** The one line the rail menu shows (a toast) after an action. */
export function railNoticeText(n: OrgIconNotice, orgName: string): string {
  if (n.kind === 'error') return t(n.key);
  return t(n.kind === 'saved' ? 'orgIcon.menu.saved' : 'orgIcon.menu.removed', { name: orgName });
}

/** The items of the rail menu: "Remove icon" only when the org has an icon. */
export function railMenuItems(hasIcon: boolean): Array<'set' | 'remove'> {
  return hasIcon ? ['set', 'remove'] : ['set'];
}
