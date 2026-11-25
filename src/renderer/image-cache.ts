// Images of thread messages, loaded once per id: the thread log holds only ids, the bytes come from the main process.
import { api } from './api';

const cache = new Map<string, Promise<string | null>>();

/** The `data:` URL of a stored image, or null when it is gone. Found images are kept for the session; a miss is asked again next time. */
export function loadImage(orgId: string, id: string): Promise<string | null> {
  const key = `${orgId}|${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = api()
    .getImage(orgId, id)
    .catch(() => null)
    .then((url) => {
      if (url === null) cache.delete(key);
      return url;
    });
  cache.set(key, p);
  return p;
}
