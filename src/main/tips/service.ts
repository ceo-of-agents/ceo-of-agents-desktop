// Which tip the org shows now, and dismissals. Dismissals and the off switch live in the app's per-org settings file
// (<dataDir>/orgs/<orgId>/settings.json, see settings.ts), never in the hq; `tips.show` and `tips.dismissed` of the hq's org.yaml
// are honored too (read only).
import fs from 'node:fs';
import path from 'node:path';
import { loadHq } from '../hq/read';
import type { SettingsStore } from '../settings';
import { appTips } from './app-tips';
import { gatherFacts, readOrgTipsKey } from './facts';
import type { PluginTipsSource } from './plugin-tips';
import { selectTips, type TipView } from './tips';

export interface TipsServiceDeps {
  settings: SettingsStore;
  plugin: PluginTipsSource;
  now?: () => Date;
}

export class TipsService {
  constructor(private readonly d: TipsServiceDeps) {}

  /** The tip to show for this org, or null (tips off, nothing applies, hq unreadable). Never throws. */
  async current(orgId: string, hqPath: string): Promise<TipView | null> {
    return (await this.list(orgId, hqPath))[0] ?? null;
  }

  /** The applicable, not dismissed tips in display order (the first is the current tip); empty when tips are off, none applies or the hq is unreadable. Never throws. */
  async list(orgId: string, hqPath: string): Promise<TipView[]> {
    try {
      if (!this.d.settings.tipsOn(orgId)) return [];
      let orgYaml = '';
      try {
        orgYaml = fs.readFileSync(path.join(hqPath, 'org.yaml'), 'utf8');
      } catch {
        return [];
      }
      const hqKey = readOrgTipsKey(orgYaml);
      if (!hqKey.show) return [];
      const hq = loadHq(hqPath);
      if (!hq.orgReadable) return [];
      const plugin = await this.d.plugin.get();
      const facts = gatherFacts(hqPath, hq, plugin.version, this.d.now?.());
      const dismissed = new Set([...this.d.settings.tipsDismissed(orgId), ...hqKey.dismissed]);
      return selectTips([...plugin.tips, ...appTips()], facts, dismissed);
    } catch {
      return [];
    }
  }

  dismiss(orgId: string, tipId: string): void {
    this.d.settings.dismissTip(orgId, tipId);
  }
}
