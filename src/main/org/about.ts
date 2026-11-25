// The About section: versions of the app, Claude Code, the plugin and the org, from what the app already knows.
import type { AboutInfo, PluginStatus, PrereqStatus } from '../../shared/types';

export interface AboutInput {
  appVersion: string;
  /** The last prerequisite check, null before the first one. */
  prereq: PrereqStatus | null;
  /** The plugin status last read for this org, null when never read. */
  plugin: PluginStatus | null;
  /** framework_version in the org's org.yaml. */
  frameworkVersion: string | null;
  hqPath: string;
}

/** Pure. Anything not known is null (the window shows "Unknown"); nothing here reaches the network. */
export function buildAbout(i: AboutInput): AboutInfo {
  const claude = i.prereq?.claude;
  return {
    appVersion: i.appVersion,
    claudeVersion: claude?.version ?? null,
    claudeRange: claude?.range || null,
    pluginInstalled: i.plugin?.installed ?? null,
    pluginLatest: i.plugin?.latest ?? null,
    frameworkVersion: i.frameworkVersion,
    hqPath: i.hqPath,
  };
}
