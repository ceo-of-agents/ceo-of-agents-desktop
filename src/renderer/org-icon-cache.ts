// The org icon as a `data:` URL, fetched once per org and file version: the key holds the stamp (`<mtimeMs>-<size>`) of the icon file.
import { useEffect, useState } from 'react';
import { api } from './api';

const cache = new Map<string, Promise<string | null>>();
/** The key last cached per org: when the stamp changes, the previous entry (up to ~1 MB of base64) is dropped. */
const latest = new Map<string, string>();

/** Number of cached icons (for tests). */
export function orgIconCacheSize(): number {
  return cache.size;
}

/** The key under which an icon is cached; null when the org has no icon file. */
export function orgIconKey(orgId: string, iconStamp: string | null | undefined): string | null {
  return iconStamp ? `${orgId}|${iconStamp}` : null;
}

/** The icon of an org at this stamp. A miss is asked again next time. */
export function loadOrgIcon(orgId: string, iconStamp: string | null | undefined): Promise<string | null> {
  const key = orgIconKey(orgId, iconStamp);
  if (!key) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit) return hit;
  const old = latest.get(orgId);
  if (old && old !== key) cache.delete(old);
  latest.set(orgId, key);
  const p = api()
    .getOrgIcon(orgId)
    .catch(() => null)
    .then((url) => {
      if (url === null && cache.get(key) === p) {
        cache.delete(key);
        if (latest.get(orgId) === key) latest.delete(orgId);
      }
      return url;
    });
  cache.set(key, p);
  return p;
}

/** The icon URL of an org, or null while it loads, when there is none, or when the image failed to show (`failed`). */
export function useOrgIcon(orgId: string, iconStamp: string | null | undefined): string | null {
  const key = orgIconKey(orgId, iconStamp);
  const [loaded, setLoaded] = useState<{ key: string | null; url: string | null }>({ key: null, url: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadOrgIcon(orgId, iconStamp).then((url) => {
      if (live) setLoaded({ key, url });
    });
    return () => {
      live = false;
    };
  }, [orgId, iconStamp, key]);
  return key && loaded.key === key ? loaded.url : null;
}
