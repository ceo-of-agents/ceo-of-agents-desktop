// The text in each chat's composer, kept per chat (`orgId|threadId`) outside React state: typing updates this store and only the
// parts of the composer that read the text re-render, not the app or the message list. Kept while another tab is shown, like the
// images (`draftImages`) and files (`draftFiles`).
import { useSyncExternalStore } from 'react';

const kept = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

const notify = (key: string): void => {
  for (const l of [...(listeners.get(key) ?? [])]) l();
};

export const draftText = {
  get: (key: string): string => kept.get(key) ?? '',
  set: (key: string, text: string): void => {
    if ((kept.get(key) ?? '') === text) return;
    if (text === '') kept.delete(key);
    else kept.set(key, text);
    notify(key);
  },
  delete: (key: string): void => {
    if (kept.delete(key)) notify(key);
  },
  deleteOrg: (orgId: string): void => {
    const prefix = `${orgId}|`;
    for (const key of [...kept.keys()]) if (key.startsWith(prefix)) draftText.delete(key);
  },
  subscribe: (key: string, listener: () => void): (() => void) => {
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
    };
  },
  size: (): number => kept.size,
};

/** The chat's composer text; re-renders only the component that calls it. */
export function useDraftText(key: string): string {
  return useSyncExternalStore(
    (listener) => draftText.subscribe(key, listener),
    () => draftText.get(key),
  );
}
