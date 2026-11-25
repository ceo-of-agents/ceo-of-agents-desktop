// The tips file of the installed plugin: `tips/tips.yaml` in the plugin folder (plugin 0.21.0+). The app reads it where it
// is installed and keeps no copy. A plugin without the file (older than 0.21.0) gives no plugin tips.
import fs from 'node:fs';
import path from 'node:path';
import { pluginVersionAt } from '../setup/plugin-data';
import { parseTips, type Tip } from './tips';

const MAX_TIPS_FILE = 256 * 1024;

export interface PluginTips {
  /** Version in the plugin's manifest, null when unknown or not installed. */
  version: string | null;
  tips: Tip[];
}

export const NO_PLUGIN_TIPS: PluginTips = { version: null, tips: [] };

/** Reads `<dir>/tips/tips.yaml`. Never throws: a missing, oversized or invalid file gives no tips. */
export function readPluginTips(dir: string, fallbackVersion: string | null = null): PluginTips {
  const version = pluginVersionAt(dir) ?? fallbackVersion;
  const file = path.join(dir, 'tips', 'tips.yaml');
  try {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_TIPS_FILE) return { version, tips: [] };
    return { version, tips: parseTips(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { version, tips: [] };
  }
}

export type FindPluginDir = () => Promise<{ dir: string; version: string } | null>;

/**
 * Finds the installed plugin (`findDir`, which asks `claude plugin list`, a process: so the answer is kept for `ttlMs`) and
 * reads its tips file. One lookup at a time; a failed lookup is not kept for long.
 */
export class PluginTipsSource {
  private cached: { at: number; value: PluginTips } | null = null;
  private inflight: Promise<PluginTips> | null = null;

  constructor(
    private readonly findDir: FindPluginDir,
    private readonly ttlMs = 2 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.cached = null;
  }

  async get(): Promise<PluginTips> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value;
    if (!this.inflight) {
      this.inflight = (async () => {
        let value = NO_PLUGIN_TIPS;
        try {
          const found = await this.findDir();
          if (found) value = readPluginTips(found.dir, found.version || null);
        } catch {
          value = NO_PLUGIN_TIPS;
        }
        this.cached = { at: this.now(), value };
        return value;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
}
