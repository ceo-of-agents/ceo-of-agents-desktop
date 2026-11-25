import fs from 'node:fs';

export type HqChange = 'state' | 'initiatives' | 'org' | 'agents' | 'look' | 'inbox' | 'settings' | 'icon';

export function classify(relPath: string): HqChange | null {
  const p = relPath.split('\\').join('/');
  if (p === '.git' || p.startsWith('.git/')) return null;
  if (p === 'company/state.md' || p === 'company/todo.md') return 'state';
  if (p === 'company/icon.png') return 'icon';
  if (p === 'initiatives' || p.startsWith('initiatives/')) return 'initiatives';
  if (p === 'org.yaml' || p === 'CLAUDE.md') return 'org';
  if (p === '.claude/agents' || p.startsWith('.claude/agents/')) return 'agents';
  if (/^departments\/[^/]+\/app-look\.yaml$/.test(p)) return 'look';
  if (p === '.claude/settings.json' || p === '.claude/settings.local.json') return 'settings';
  if (p === 'inbox' || p.startsWith('inbox/')) return 'inbox';
  return null;
}

/** Calls `onChange` once per kind of change, after `debounceMs` without further events of that kind. */
export function watchHq(hqPath: string, onChange: (what: HqChange) => void, debounceMs = 200): { close(): void } {
  const timers = new Map<HqChange, NodeJS.Timeout>();
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(hqPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const kind = classify(filename.toString());
      if (!kind) return;
      const old = timers.get(kind);
      if (old) clearTimeout(old);
      timers.set(
        kind,
        setTimeout(() => {
          timers.delete(kind);
          try {
            onChange(kind);
          } catch {
            // listener errors must not kill the watcher
          }
        }, debounceMs),
      );
    });
    watcher.on('error', () => {
      /* folder disappeared: stay quiet */
    });
  } catch {
    watcher = null;
  }
  return {
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      watcher = null;
    },
  };
}
