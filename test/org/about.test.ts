import { describe, expect, it } from 'vitest';
import { buildAbout } from '../../src/main/org/about';
import type { PluginStatus, PrereqStatus } from '../../src/shared/types';

const plugin = { installed: '1.4.0', latest: '1.5.0' } as PluginStatus;
const prereq = { claude: { found: true, path: '/usr/bin/claude', version: '2.1.327', supported: true, range: '>=2.1.326 <2.2.0' } } as PrereqStatus;

describe('buildAbout', () => {
  it('passes the known values through', () => {
    expect(buildAbout({ appVersion: '0.3.0', prereq, plugin, frameworkVersion: '1.3.0', hqPath: '/tmp/hq' })).toEqual({
      appVersion: '0.3.0',
      claudeVersion: '2.1.327',
      claudeRange: '>=2.1.326 <2.2.0',
      pluginInstalled: '1.4.0',
      pluginLatest: '1.5.0',
      frameworkVersion: '1.3.0',
      hqPath: '/tmp/hq',
    });
  });

  it('gives null for everything not known yet', () => {
    expect(buildAbout({ appVersion: '0.3.0', prereq: null, plugin: null, frameworkVersion: null, hqPath: '/tmp/hq' })).toEqual({
      appVersion: '0.3.0',
      claudeVersion: null,
      claudeRange: null,
      pluginInstalled: null,
      pluginLatest: null,
      frameworkVersion: null,
      hqPath: '/tmp/hq',
    });
  });

  it('gives null for a missing Claude Code, an uninstalled plugin and an offline latest', () => {
    const missing = { claude: { found: false, path: null, version: null, supported: false, range: '' } } as PrereqStatus;
    const a = buildAbout({ appVersion: '0.3.0', prereq: missing, plugin: { installed: null, latest: null } as PluginStatus, frameworkVersion: null, hqPath: '/tmp/hq' });
    expect(a).toMatchObject({ claudeVersion: null, claudeRange: null, pluginInstalled: null, pluginLatest: null });
  });
});
