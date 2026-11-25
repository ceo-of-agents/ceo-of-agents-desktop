import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatherFacts, lastUpdatedOf, newestBriefDate, readOrgTipsKey, recordDate } from '../../src/main/tips/facts';
import { NO_PLUGIN_TIPS, PluginTipsSource, readPluginTips } from '../../src/main/tips/plugin-tips';
import { TipsService } from '../../src/main/tips/service';
import { loadHq } from '../../src/main/hq/read';
import { SettingsStore } from '../../src/main/settings';

const released = fs.readFileSync(path.join(__dirname, '../fixtures/tips/tips.yaml'), 'utf8');

let root: string;
let data: string;
let plugin: string;
const write = (base: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};

function mkHq(name: string, opts: { orgYaml?: string; state?: string; briefs?: string[]; icon?: boolean } = {}): string {
  const hq = path.join(root, name);
  write(hq, 'org.yaml', opts.orgYaml ?? 'org:\n  id: X\n  name: Test\ncos:\n  display_name: Nora\nlanguage:\n  chat: en\nframework_version: "0.21.0"\n');
  write(hq, 'CLAUDE.md', '# hq\n');
  write(hq, 'company/state.md', opts.state ?? '---\nlast_updated: 2026-03-09\n---\n\n## Waiting on the CEO\n\n- X-A1 [normal] {ok}: one (since 2026-03-01)\n- X-A2 [normal] {ok}: two (since 2026-03-02)\n- X-A3 [normal] {ok}: three (since 2026-03-03)\n');
  write(hq, 'decisions/0001-setup.md', '# 0001. Setup\n\n- Date: 2026-01-01\n- Status: accepted\n');
  for (const b of opts.briefs ?? ['2026-03-09-brief.md']) write(hq, `company/briefs/${b}`, '# brief\n');
  if (opts.icon) write(hq, 'company/icon.png', '\x89PNG\r\n\x1a\n' + 'x'.repeat(20));
  return hq;
}

const now = () => new Date(2026, 2, 10, 12, 0, 0); // 2026-03-10 local

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-tips-'));
  data = path.join(root, 'data');
  plugin = path.join(root, 'plugin');
  write(plugin, '.claude-plugin/plugin.json', JSON.stringify({ name: 'p', version: '0.21.0' }));
  write(plugin, 'tips/tips.yaml', released);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('hq facts', () => {
  it('reads last_updated, the newest brief, the setup date and the org.yaml tips key', () => {
    expect(lastUpdatedOf('---\nlast_updated: 2026-03-09\nx: 1\n---\nbody')).toBe('2026-03-09');
    expect(lastUpdatedOf('no frontmatter')).toBeNull();
    expect(lastUpdatedOf('---\nlast_updated: soon\n---\n')).toBeNull();
    expect(newestBriefDate(['2026-02-01-a.md', '2026-03-05-b.md', 'README.md', '2026-03-01-c.md'])).toBe('2026-03-05');
    expect(newestBriefDate(['README.md'])).toBeNull();
    expect(recordDate('# 0001\n\n- Date: 2026-01-01\n- Status: accepted\n')).toBe('2026-01-01');
    expect(readOrgTipsKey('tips:\n  show: false\n  dismissed: [a, 3, b]\n')).toEqual({ show: false, dismissed: ['a', 'b'] });
    expect(readOrgTipsKey('org: {}\n')).toEqual({ show: true, dismissed: [] });
    expect(readOrgTipsKey(':\n[')).toEqual({ show: true, dismissed: [] });
  });
  it('gathers the pending items (T items and unparsed lines left out), the cos name and the chat language', () => {
    const hq = mkHq('a');
    write(hq, 'company/todo.md', '## Open\n\n- X-T1: mine\n');
    const f = gatherFacts(hq, loadHq(hq), '0.21.0', now());
    expect(f).toMatchObject({ today: '2026-03-10', frameworkVersion: '0.21.0', pluginVersion: '0.21.0', cosName: 'Nora', chatLanguage: 'en', lastUpdated: '2026-03-09', lastBriefDate: '2026-03-09', hqSetupDate: '2026-01-01', hasOrgIcon: false });
    expect(f.pending.map((p) => [p.code, p.action, p.since])).toEqual([['X-A1', 'ok', '2026-03-01'], ['X-A2', 'ok', '2026-03-02'], ['X-A3', 'ok', '2026-03-03']]);
    expect(f.exists('company/state.md')).toBe(true);
    expect(f.exists('company/ceo-voice.md')).toBe(false);
  });
  it('an org with no display_name has no cos name (the schema fallback applies)', () => {
    const hq = mkHq('b', { orgYaml: 'org:\n  id: X\nframework_version: "0.21.0"\n' });
    expect(gatherFacts(hq, loadHq(hq), null, now()).cosName).toBe('');
  });
});

describe('plugin tips file', () => {
  it('reads tips/tips.yaml of the plugin folder', () => {
    const r = readPluginTips(plugin);
    expect(r.version).toBe('0.21.0');
    expect(r.tips.length).toBeGreaterThan(5);
  });
  it('a plugin without the file (older than 0.21.0) gives no tips, but keeps its version', () => {
    fs.rmSync(path.join(plugin, 'tips'), { recursive: true });
    expect(readPluginTips(plugin)).toEqual({ version: '0.21.0', tips: [] });
    expect(readPluginTips(path.join(root, 'nowhere'), '0.5.0')).toEqual({ version: '0.5.0', tips: [] });
  });
  it('the source finds the folder once per ttl, and no plugin means no tips', async () => {
    let calls = 0;
    let at = 0;
    const src = new PluginTipsSource(async () => (calls++, { dir: plugin, version: '0.21.0' }), 1000, () => at);
    expect((await src.get()).tips.length).toBeGreaterThan(5);
    await src.get();
    expect(calls).toBe(1);
    at = 1500;
    await src.get();
    expect(calls).toBe(2);
    expect(await new PluginTipsSource(async () => null).get()).toEqual(NO_PLUGIN_TIPS);
    expect(await new PluginTipsSource(async () => { throw new Error('x'); }).get()).toEqual(NO_PLUGIN_TIPS);
  });
});

describe('TipsService and dismissals', () => {
  // The 9th: with three candidates (a plugin tip and the two app tips) the first one in file order shows.
  const ninth = () => new Date(2026, 2, 9, 12);
  const service = (at: () => Date = ninth) => new TipsService({ settings: new SettingsStore({ dataDir: data, userFile: path.join(root, 'none.json') }), plugin: new PluginTipsSource(async () => ({ dir: plugin, version: '0.21.0' })), now: at });

  it('shows the filled tip of the open org (first candidate in file order)', async () => {
    const hq = mkHq('a', { icon: false });
    const tip = await service().current('a', hq);
    expect(tip).toEqual({ id: 'approve-several', text: 'Several items wait on your OK. You can clear them in one message.', phrase: 'Approve X-A1, X-A2, X-A3' });
  });
  it('dismissal persists per org in the app data folder, not in the hq, and survives a restart', async () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const s = service();
    s.dismiss('a', 'approve-several');
    s.dismiss('a', 'approve-several');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'orgs', 'a', 'settings.json'), 'utf8'))).toEqual({ tipsDismissed: ['approve-several'] });
    expect((await service().current('a', a))?.id).not.toBe('approve-several');
    expect((await service().current('b', b))?.id).toBe('approve-several');
    expect(fs.readFileSync(path.join(a, 'org.yaml'), 'utf8')).not.toContain('approve-several');
    expect(fs.existsSync(path.join(a, 'company', 'tips.json'))).toBe(false);
  });
  it('list gives every applicable tip, the current one first, and drops a dismissed one', async () => {
    const hq = mkHq('l', { orgYaml: 'org:\n  id: X\nframework_version: "0.21.0"\n' });
    const all = await service().list('l', hq);
    expect(all.length).toBeGreaterThan(1);
    expect(all[0]).toEqual(await service().current('l', hq));
    const s = service();
    s.dismiss('l', all[0].id);
    expect((await s.list('l', hq)).map((x) => x.id)).not.toContain(all[0].id);
  });
  it('ignores a dismissal with an implausible id', () => {
    service().dismiss('a', '../x');
    expect(fs.existsSync(path.join(data, 'orgs', 'a', 'settings.json'))).toBe(false);
  });
  it('the Settings switch turns every tip off for that org only', async () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const st = new SettingsStore({ dataDir: data, userFile: path.join(root, 'none.json') });
    expect(st.get('a', a).tips).toBe(true);
    expect(st.set('a', a, { tips: false }).tips).toBe(false);
    const s = new TipsService({ settings: st, plugin: new PluginTipsSource(async () => ({ dir: plugin, version: '0.21.0' })), now });
    expect(await s.current('a', a)).toBeNull();
    expect(await s.current('b', b)).not.toBeNull();
    expect(new SettingsStore({ dataDir: data, userFile: path.join(root, 'none.json') }).tipsOn('a')).toBe(false);
    st.set('a', a, { tips: true });
    expect(await s.current('a', a)).not.toBeNull();
  });
  it('honors tips.show and tips.dismissed of the hq org.yaml', async () => {
    const off = mkHq('off', { orgYaml: 'framework_version: "0.21.0"\ntips:\n  show: false\n' });
    expect(await service().current('off', off)).toBeNull();
    const some = mkHq('some', { orgYaml: 'framework_version: "0.21.0"\ncos:\n  display_name: Nora\ntips:\n  dismissed: [approve-several]\n' });
    expect((await service().current('some', some))?.id).not.toBe('approve-several');
  });
  it('without plugin tips only the app tips show; an older hq or no icon changes which', async () => {
    const hq = mkHq('a', { orgYaml: 'org:\n  id: X\nframework_version: "0.21.0"\n' });
    const s = new TipsService({ settings: new SettingsStore({ dataDir: data, userFile: path.join(root, 'none.json') }), plugin: new PluginTipsSource(async () => null), now });
    const tip = await s.current('a', hq);
    expect(['app-org-icon', 'app-paste-images']).toContain(tip!.id);
    const withIcon = mkHq('c', { orgYaml: 'org:\n  id: X\nframework_version: "0.21.0"\n', icon: true });
    // a real PNG is needed for the icon check, so the fake bytes above do not count: the icon tip still applies
    expect(['app-org-icon', 'app-paste-images']).toContain((await s.current('c', withIcon))!.id);
  });
  it('shows the translation in the chat language', async () => {
    write(plugin, 'tips/tips.yaml', `schema: tips/1
tips:
  - id: resume
    since: "0.14.0"
    when: {days_since_last_session: {min: 7}}
    text: "Ask {cos_name}."
    phrase: "Resume"
    translations:
      it: {text: "Chiedi a {cos_name}.", phrase: "Riprendi"}
`);
    const hq = mkHq('a', { orgYaml: 'cos:\n  display_name: Nora\nlanguage:\n  chat: it\nframework_version: "0.21.0"\n', state: '---\nlast_updated: 2026-02-01\n---\n## Waiting on the CEO\n' });
    expect(await service().current('a', hq)).toEqual({ id: 'resume', text: 'Chiedi a Nora.', phrase: 'Riprendi' });
  });
  it('an unreadable hq gives no tip, never an error', async () => {
    expect(await service().current('x', path.join(root, 'missing'))).toBeNull();
    const bad = mkHq('bad', { orgYaml: ':\n[' });
    expect(await service().current('bad', bad)).toBeNull();
  });
});
