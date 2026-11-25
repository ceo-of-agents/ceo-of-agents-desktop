import { describe, expect, it } from 'vitest';
import type { HealthColor, Initiative, PluginStatus, PrereqStatus, Settings, ThreadEntry, ThreadInfo } from '../../src/shared/types';
import { chatEffortOptions, chatModelOptions, chatModelShown, chatModelTip, modelSourceNote, turnModelTip, chatEffortShown, runPendingNote, chatModeShown, affectsSessions, elapsedLabel, groupInitiatives, healthLabel, initials, isBlocking, livePhase, modelOptions, pluginActions, pluginBadgeView, pluginLabel, pluginStepLabel, runLabel, shorten, stepsLabel, tabActivity, withDaySeparators } from '../../src/renderer/logic';

const entry = (id: string, d: Date, kind: ThreadEntry['kind'] = 'user'): ThreadEntry => ({ id, kind, author: 'x', text: id, time: d.toISOString() });

describe('withDaySeparators', () => {
  it('adds a separator at each local day change', () => {
    const rows = withDaySeparators([
      entry('a', new Date(2026, 10, 16, 23, 30)),
      entry('b', new Date(2026, 10, 16, 23, 59)),
      entry('c', new Date(2026, 10, 17, 0, 1)),
    ]);
    expect(rows.map((r) => r.type)).toEqual(['day', 'entry', 'entry', 'day', 'entry']);
    expect(rows[0]).toMatchObject({ day: '2026-11-16' });
    expect(rows[3]).toMatchObject({ day: '2026-11-17' });
  });
  it('returns nothing for no entries', () => {
    expect(withDaySeparators([])).toEqual([]);
  });
});

const ini = (slug: string, state: Initiative['state']): Initiative => ({ slug, title: slug, state, updated: null, goal: '', stateText: '', nextStep: '' });

describe('groupInitiatives', () => {
  it('groups by state and puts unknown in progress', () => {
    const g = groupInitiatives([ini('a', 'active'), ini('b', 'paused'), ini('c', 'done'), ini('d', 'dropped'), ini('e', 'unknown')]);
    expect(g.inProgress.map((i) => i.slug)).toEqual(['a', 'e']);
    expect(g.onHold.map((i) => i.slug)).toEqual(['b']);
    expect(g.closed.map((i) => i.slug)).toEqual(['c', 'd']);
  });
});

const plugin = (over: Partial<PluginStatus> = {}): PluginStatus => ({
  state: 'ok', installed: '1.2.0', latest: '1.2.0', updateAvailable: false, hqFrameworkVersion: '1.2.0', orgUpdateAvailable: false, belowMinimum: false, minimum: '1.0.0', latestCheckFailed: false, dev: false, ...over,
});
const prereq = (over: Partial<PrereqStatus> = {}): PrereqStatus => ({
  claude: { found: true, path: '/x', version: '2.1.330', supported: true, range: '>=2.1.326' },
  signedIn: true,
  git: { found: true, version: '2.40', devToolsMissing: false },
  plugin: plugin(),
  checkedAt: '2026-11-17T10:00:00Z',
  ...over,
});

describe('isBlocking', () => {
  it('is false when all is fine, or unknown', () => {
    expect(isBlocking(prereq())).toBe(false);
    expect(isBlocking(null)).toBe(false);
    expect(isBlocking(prereq({ plugin: null }))).toBe(false);
  });
  it('blocks on each failing check', () => {
    expect(isBlocking(prereq({ claude: { found: false, path: null, version: null, supported: false, range: '' } }))).toBe(true);
    expect(isBlocking(prereq({ claude: { found: true, path: '/x', version: '3.0.0', supported: false, range: '' } }))).toBe(true);
    expect(isBlocking(prereq({ signedIn: false }))).toBe(true);
    expect(isBlocking(prereq({ git: { found: false, version: null, devToolsMissing: true } }))).toBe(true);
    expect(isBlocking(prereq({ plugin: plugin({ state: 'missing' }) }))).toBe(true);
    expect(isBlocking(prereq({ plugin: plugin({ state: 'enabled-not-installed' }) }))).toBe(true);
  });
  it('does not block when an update is only available', () => {
    expect(isBlocking(prereq({ plugin: plugin({ updateAvailable: true, latest: '1.3.0' }) }))).toBe(false);
  });
});

describe('pluginLabel and pluginActions', () => {
  it('up to date: one label, no button', () => {
    expect(pluginLabel(plugin())).toBe('ceo-of-agents · v1.2.0 · up to date');
    expect(pluginActions(plugin())).toEqual({ update: false, retry: false });
  });
  it('plugin behind: Update', () => {
    const s = plugin({ updateAvailable: true, latest: '1.3.0' });
    expect(pluginLabel(s)).toBe('ceo-of-agents · update available (plugin v1.2.0 → v1.3.0)');
    expect(pluginActions(s)).toEqual({ update: true, retry: false });
  });
  it('hq behind: Update', () => {
    const s = plugin({ hqFrameworkVersion: '1.1.0', orgUpdateAvailable: true });
    expect(pluginLabel(s)).toBe('ceo-of-agents · update available (hq v1.1.0 → v1.2.0)');
    expect(pluginActions(s)).toEqual({ update: true, retry: false });
  });
  it('both behind: one label (the plugin) and one Update', () => {
    const s = plugin({ updateAvailable: true, latest: '1.3.0', hqFrameworkVersion: '1.1.0', orgUpdateAvailable: true });
    expect(pluginLabel(s)).toBe('ceo-of-agents · update available (plugin v1.2.0 → v1.3.0)');
    expect(pluginActions(s)).toEqual({ update: true, retry: false });
  });
  it('dev folder: no plugin update, the hq can still be updated', () => {
    const s = plugin({ dev: true, latest: '9.0.0', updateAvailable: true, latestCheckFailed: true });
    expect(pluginLabel(s)).toBe('plugin v1.2.0 (dev folder)');
    expect(pluginActions(s)).toEqual({ update: false, retry: false });
    const hq = plugin({ dev: true, hqFrameworkVersion: '1.0.0', orgUpdateAvailable: true });
    expect(pluginLabel(hq)).toBe('ceo-of-agents · update available (hq v1.0.0 → v1.2.0)');
    expect(pluginActions(hq)).toEqual({ update: true, retry: false });
  });
  it('latest unknown: says so, with a Retry', () => {
    const s = plugin({ latest: null, latestCheckFailed: true });
    expect(pluginLabel(s)).toBe('plugin v1.2.0 · latest version unknown');
    expect(pluginActions(s)).toEqual({ update: false, retry: true });
  });
  it('latest unknown and hq behind: Update, no separate Retry', () => {
    const s = plugin({ latest: null, latestCheckFailed: true, hqFrameworkVersion: '1.1.0', orgUpdateAvailable: true });
    expect(pluginLabel(s)).toBe('ceo-of-agents · update available (hq v1.1.0 → v1.2.0)');
    expect(pluginActions(s)).toEqual({ update: true, retry: false });
  });
  it('not installed, no version, no status', () => {
    expect(pluginLabel(plugin({ state: 'missing', installed: null }))).toContain('not installed');
    expect(pluginActions(plugin({ state: 'missing', installed: null, updateAvailable: true }))).toEqual({ update: false, retry: false });
    expect(pluginLabel(plugin({ installed: null }))).toContain('version unknown');
    expect(pluginLabel(null)).toBe('');
    expect(pluginActions(null)).toEqual({ update: false, retry: false });
  });
});

describe('healthLabel', () => {
  it('has a label for each colour', () => {
    const colours: HealthColor[] = ['green', 'yellow', 'orange', 'red'];
    for (const c of colours) expect(healthLabel(c)).not.toContain('health.label');
    expect(healthLabel('yellow')).toBe('Needs sync');
  });
});

describe('initials', () => {
  it('takes two letters', () => {
    expect(initials('CEO of Agents')).toBe('CO');
    expect(initials('acme')).toBe('AC');
    expect(initials('')).toBe('?');
  });
});

describe('withDaySeparators: old tool entries', () => {
  const at = (h: number) => new Date(2026, 10, 16, h);
  it('folds consecutive tool entries into one row with a count', () => {
    const rows = withDaySeparators([entry('a', at(9)), entry('t1', at(9), 'tool'), entry('t2', at(9), 'tool'), entry('t3', at(10), 'tool'), entry('b', at(10), 'assistant')]);
    expect(rows.map((r) => r.type)).toEqual(['day', 'entry', 'tools', 'entry']);
    expect(rows[2]).toMatchObject({ type: 'tools', id: 't1', count: 3 });
  });
  it('keeps separate runs apart and does not fold across a day change', () => {
    const rows = withDaySeparators([entry('t1', at(9), 'tool'), entry('x', at(9)), entry('t2', at(9), 'tool'), entry('t3', new Date(2026, 10, 17, 1), 'tool')]);
    expect(rows.map((r) => r.type)).toEqual(['day', 'tools', 'entry', 'tools', 'day', 'tools']);
    expect(rows.filter((r) => r.type === 'tools').map((r) => (r as { count: number }).count)).toEqual([1, 1, 1]);
  });
  it('leaves activity entries as entries', () => {
    const rows = withDaySeparators([entry('act', at(9), 'activity')]);
    expect(rows.map((r) => r.type)).toEqual(['day', 'entry']);
  });
});

describe('stepsLabel', () => {
  it('is singular for one', () => {
    expect(stepsLabel(1)).toBe('1 step');
    expect(stepsLabel(12)).toBe('12 steps');
  });
});

describe('livePhase', () => {
  it('a pending permission wins over everything', () => {
    expect(livePhase({ permissionPending: true, streaming: 'abc', current: 'Reading x' })).toEqual({ phase: 'permission', text: 'Waiting for your OK' });
  });
  it('a pending question wins over a permission and everything else', () => {
    expect(livePhase({ permissionPending: true, questionPending: true, streaming: 'abc', current: 'Reading x' })).toEqual({ phase: 'question', text: 'Waiting for your answer' });
  });
  it('streaming text beats the current step', () => {
    expect(livePhase({ permissionPending: false, streaming: 'abc', current: 'Reading x' })).toEqual({ phase: 'writing', text: 'Writing' });
  });
  it('shows the current step', () => {
    expect(livePhase({ permissionPending: false, streaming: '', current: 'Reading x' })).toEqual({ phase: 'step', text: 'Reading x' });
  });
  it('otherwise thinking', () => {
    for (const current of [null, undefined, '']) expect(livePhase({ permissionPending: false, streaming: '', current })).toEqual({ phase: 'thinking', text: 'Thinking' });
  });
});

describe('elapsedLabel', () => {
  const start = new Date(2026, 10, 16, 9, 0, 0);
  it('formats seconds and minutes', () => {
    expect(elapsedLabel(start.toISOString(), start.getTime() + 40_000)).toBe('0:40');
    expect(elapsedLabel(start.toISOString(), start.getTime() + 125_000)).toBe('2:05');
    expect(elapsedLabel(start.toISOString(), start.getTime() - 5000)).toBe('0:00');
  });
  it('is empty without a valid start', () => {
    expect(elapsedLabel(null, 1)).toBe('');
    expect(elapsedLabel(undefined, 1)).toBe('');
    expect(elapsedLabel('nope', 1)).toBe('');
  });
});

describe('shorten and tabActivity', () => {
  const th = (over: Partial<ThreadInfo>): ThreadInfo => ({ orgId: 'o', threadId: 'cos', busy: false, handoffsWaiting: 0, title: '', speaker: '', entries: [], streaming: '', ...over });
  it('shorten cuts with an ellipsis', () => {
    expect(shorten('short', 10)).toBe('short');
    expect(shorten('abcdefghij', 5)).toBe('abcd…');
  });
  it('is empty for an idle or missing thread', () => {
    expect(tabActivity(undefined)).toBe('');
    expect(tabActivity(th({ activity: { startedAt: 'x', current: 'Reading a', steps: 1 } }))).toBe('');
  });
  it('shows the current step of a busy thread, truncated', () => {
    expect(tabActivity(th({ busy: true, activity: { startedAt: 'x', current: 'Reading a', steps: 1 } }))).toBe('Reading a');
    expect(tabActivity(th({ busy: true, activity: { startedAt: 'x', current: 'x'.repeat(60), steps: 1 } })).length).toBe(28);
  });
  it('says thinking when busy without a step', () => {
    expect(tabActivity(th({ busy: true }))).toBe('Thinking');
    expect(tabActivity(th({ busy: true, activity: { startedAt: 'x', current: null, steps: 0 } }))).toBe('Thinking');
  });
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  permissionMode: 'default', permissionModeSource: 'default', effort: 'high', effortSource: 'default', model: null, cosModel: 'opus',
  cosModelSource: 'org-yaml', orgYamlModel: 'opus', modelTiers: [], seenModels: [], autoPush: true, newSessionAfterMinutes: 30, renewSessionAtTokens: 100000, tips: true, ...over,
});

describe('settings helpers', () => {
  it('only mode, effort and model need a restart', () => {
    expect(affectsSessions({ permissionMode: 'plan' })).toBe(true);
    expect(affectsSessions({ effort: 'low' })).toBe(true);
    expect(affectsSessions({ model: null })).toBe(true);
    expect(affectsSessions({ autoPush: false })).toBe(false);
  });
  it('model options: org.yaml first, the aliases that follow the latest, then the specific models', () => {
    expect(modelOptions(settings()).map((o) => o.label)).toEqual(['As set in org.yaml (opus)', 'Opus (latest)', 'Sonnet (latest)', 'Haiku (latest)']);
    expect(modelOptions(settings({ modelTiers: ['big', 'small'], orgYamlModel: null })).map((o) => o.label)).toEqual(['As set in org.yaml (Claude Code default)', 'Big', 'Small']);
    expect(modelOptions(settings({ model: 'custom-1' })).map((o) => o.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'custom-1']);
    const o = modelOptions(settings({ model: 'claude-opus-5-5', seenModels: ['claude-sonnet-4-5-20250929', 'claude-opus-5-5'] }));
    expect(o.map((x) => x.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-4-5-20250929']);
    expect(o.slice(4).map((x) => x.label)).toEqual(['Opus 5.5', 'Sonnet 4.5']);
  });
  it('the note under the model says "Pinned for this org" for a specific model', () => {
    expect(modelSourceNote(settings({ model: 'claude-opus-5-5', cosModel: 'claude-opus-5-5', cosModelSource: 'override' }))).toBe('Pinned for this org: Opus 5.5');
    expect(modelSourceNote(settings({ model: 'sonnet', cosModelSource: 'override' }))).toBe('Your choice for this org');
    expect(modelSourceNote(settings())).toBe("From this org's org.yaml");
  });
  it('run label', () => {
    expect(runLabel('opus', 'medium')).toBe('opus · effort medium');
    expect(runLabel(null, 'high')).toBe('Claude Code default model · effort high');
    expect(runLabel(undefined, undefined)).toBe('');
  });
});

describe('chat picker helpers', () => {
  it('model options: org default first, tiers, then the chat own custom value', () => {
    expect(chatModelOptions({ defaultModel: 'opus' }).map((o) => o.label)).toEqual(['Org default (Opus)', 'Opus (latest)', 'Sonnet (latest)', 'Haiku (latest)']);
    expect(chatModelOptions({ defaultModel: null, tiers: ['big'] }).map((o) => o.label)).toEqual(['Org default (Claude Code default)', 'Big']);
    expect(chatModelOptions({ defaultModel: 'opus', current: 'custom-1' }).map((o) => o.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'custom-1']);
  });
  it('model options: aliases first, seen ids deduplicated, the current choice and the resolved id always present', () => {
    const seen = ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-opus-5-5'];
    const o = chatModelOptions({ defaultModel: 'opus', seen, current: 'claude-sonnet-4-5-20250929', resolved: 'claude-opus-5-5' });
    expect(o.map((x) => x.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-sonnet-4-5-20250929', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect(o.map((x) => x.label).slice(4)).toEqual(['Sonnet 4.5', 'Opus 5.5', 'Haiku 4.5']);
    // a current choice that is already seen is not listed twice
    expect(chatModelOptions({ defaultModel: 'opus', seen, current: 'claude-haiku-4-5' }).map((x) => x.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-haiku-4-5', 'claude-opus-5-5']);
  });
  it('the org default option: "Org default (Opus)" for a tier, "Pinned for this org: Opus 5.5" for a pinned model', () => {
    expect(chatModelOptions({ defaultModel: 'opus' })[0].label).toBe('Org default (Opus)');
    expect(chatModelOptions({ defaultModel: 'claude-opus-5-5', defaultPinned: true })[0].label).toBe('Pinned for this org: Opus 5.5');
    expect(chatModelOptions({ defaultModel: 'claude-opus-5-5' })[0].label).toBe('Org default (Opus 5.5)');
  });
  it('effort options: org default first, then every level', () => {
    const o = chatEffortOptions('high');
    expect(o[0]).toEqual({ value: '', label: 'Org default (High)' });
    expect(o.map((x) => x.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(chatEffortOptions('medium', true)[0]).toEqual({ value: '', label: 'Department default, from its agent file (Medium)' });
  });
  it('the footer reads "Model: Opus" and "Effort: High", also on the org default', () => {
    expect(chatModelShown(null, 'opus')).toBe('Model: Opus');
    expect(chatModelShown(undefined, 'opus')).toBe('Model: Opus');
    expect(chatModelShown('haiku', 'opus')).toBe('Model: Haiku');
    expect(chatModelShown(null, null)).toBe('Model: Claude Code default');
  });
  it('the footer shows the resolved model once the init is known, and only while it matches what the chat wants', () => {
    expect(chatModelShown(null, 'opus', 'claude-opus-5-5')).toBe('Model: Opus 5.5');
    expect(chatModelShown('opus', 'sonnet', 'claude-opus-5-5')).toBe('Model: Opus 5.5');
    // the chat picked another tier: the running process is older, the pick shows
    expect(chatModelShown('haiku', 'opus', 'claude-opus-5-5')).toBe('Model: Haiku');
    expect(chatModelShown(null, null, 'claude-sonnet-4-5-20250929')).toBe('Model: Sonnet 4.5');
    expect(chatModelShown('claude-opus-4-1', 'opus', 'claude-opus-5-5')).toBe('Model: Opus 4.1');
    expect(chatModelShown(null, 'claude-opus-5-5')).toBe('Model: Opus 5.5');
    expect(chatModelTip(null, 'opus', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(chatModelTip(null, 'opus')).toBe('');
    expect(chatModelTip('claude-opus-4-1', 'opus', 'claude-opus-5-5')).toBe('claude-opus-4-1');
    expect(turnModelTip('claude-opus-5-5')).toBe('Model: Opus 5.5 (claude-opus-5-5)');
    expect(turnModelTip('weird-id')).toBe('Model: weird-id');
    expect(turnModelTip(undefined)).toBe('');
    expect(chatEffortShown(null, 'high')).toBe('Effort: High');
    expect(chatEffortShown('xhigh', 'high')).toBe('Effort: Extra high');
  });
  it('pending note only when a change waits', () => {
    expect(runPendingNote(undefined)).toBe('');
    expect(runPendingNote({ runPending: false } as ThreadInfo)).toBe('');
    expect(runPendingNote({ runPending: true } as ThreadInfo)).toBe('Applies from your next message');
  });
});

describe('pluginStepLabel and pluginBadgeView', () => {
  it('names each step in words', () => {
    expect(pluginStepLabel('checking', 'Ada')).toBe('Checking versions…');
    expect(pluginStepLabel('plugin', 'Ada')).toBe('Updating the plugin…');
    expect(pluginStepLabel('restart', 'Ada')).toBe('Restarting chats…');
    expect(pluginStepLabel('cos', 'Ada')).toBe('Ada is applying the hq update…');
    expect(pluginStepLabel(null, 'Ada')).toBeNull();
    expect(pluginStepLabel(undefined, 'Ada')).toBeNull();
  });
  const behind = plugin({ updateAvailable: true, latest: '1.3.0' });
  it('running: the step instead of the version label', () => {
    expect(pluginBadgeView(behind, { running: true, action: 'update', error: null, step: 'cos' }, 'Ada', false)).toEqual({ kind: 'step', text: 'Ada is applying the hq update…' });
  });
  it('running without a known step: the plain updating text', () => {
    expect(pluginBadgeView(behind, { running: true, action: 'update', error: null }, 'Ada', false)).toEqual({ kind: 'step', text: 'Updating…' });
  });
  it('error: the error text', () => {
    expect(pluginBadgeView(behind, { running: false, action: 'update', error: 'It broke.', step: null }, 'Ada', true)).toEqual({ kind: 'error', text: 'It broke.' });
  });
  it('done: "Updated" only while showDone, then the normal label', () => {
    const done = { running: false, action: 'update' as const, error: null, step: null, done: true };
    expect(pluginBadgeView(plugin(), done, 'Ada', true)).toEqual({ kind: 'done', text: 'Updated' });
    expect(pluginBadgeView(plugin(), done, 'Ada', false)).toEqual({ kind: 'label', text: 'ceo-of-agents · v1.2.0 · up to date' });
  });
  it('no action, or an install action: the normal label', () => {
    expect(pluginBadgeView(behind, null, 'Ada', false).kind).toBe('label');
    expect(pluginBadgeView(behind, { running: true, action: 'install', error: null }, 'Ada', false).kind).toBe('label');
  });
});

describe('chatModeShown', () => {
  it('names the org permission mode like Claude Code', () => {
    expect(chatModeShown('acceptEdits')).toBe('Mode: Accept edits');
    expect(chatModeShown('auto')).toBe('Mode: Auto mode');
    expect(chatModeShown('plan')).toBe('Mode: Plan mode');
    expect(chatModeShown(undefined)).toBe('Mode: Default');
  });
});

describe('settings changes: Auto mode confirm and save errors', () => {
  it('asks before switching to Auto mode, and only then', async () => {
    const { needsAutoConfirm } = await import('../../src/renderer/logic');
    expect(needsAutoConfirm('default', 'auto')).toBe(true);
    expect(needsAutoConfirm('acceptEdits', 'auto')).toBe(true);
    expect(needsAutoConfirm(undefined, 'auto')).toBe(true);
    expect(needsAutoConfirm('auto', 'auto')).toBe(false);
    for (const m of ['default', 'acceptEdits', 'plan'] as const) expect(needsAutoConfirm('auto', m)).toBe(false);
  });
  it('the confirm says commands run without asking, destructive git included, and deny rules are the only hard stop', async () => {
    const { t } = await import('../../src/shared/strings');
    const text = t('settings.mode.auto.confirm');
    expect(text).toMatch(/without asking/);
    expect(text).toMatch(/destructive git commands/);
    expect(text).toMatch(/deny rules are the only hard stop/);
  });
  it('strips Electron\'s remote-method prefix from a save error and names the file', async () => {
    const { ipcReason, settingsTarget } = await import('../../src/renderer/logic');
    const e = new Error("Error invoking remote method 'coa:setSettings': Error: settings.local.json is not valid JSON; the app did not change it.");
    expect(ipcReason(e)).toBe('settings.local.json is not valid JSON; the app did not change it.');
    expect(ipcReason('plain')).toBe('plain');
    expect(settingsTarget({ permissionMode: 'auto' })).toBe('.claude/settings.local.json');
    expect(settingsTarget({ autoPush: false })).toBe("the app's settings for this org");
    expect(settingsTarget({ newSessionAfterMinutes: 60 })).toBe("the app's settings for this org");
    expect(settingsTarget({ autoPush: true, newSessionAfterMinutes: 0 })).toBe("the app's settings for this org");
    expect(settingsTarget({ renewSessionAtTokens: 50000 })).toBe("the app's settings for this org");
    expect(settingsTarget({ effort: 'low', newSessionAfterMinutes: 60 })).toBe('.claude/settings.local.json');
  });
});

describe('ignoredRulesCounts', () => {
  it('counts the rules of both files; Clean up concerns the local ones', async () => {
    const { ignoredRulesCounts } = await import('../../src/renderer/logic');
    expect(ignoredRulesCounts({})).toEqual({ total: 0, local: 0, project: 0 });
    expect(ignoredRulesCounts({ droppedRules: { local: ['a', 'b'], project: ['c'] } })).toEqual({ total: 3, local: 2, project: 1 });
    expect(ignoredRulesCounts({ droppedRules: { local: [], project: ['c'] } })).toEqual({ total: 1, local: 0, project: 1 });
    // A rule written in both files is one rule in the total.
    expect(ignoredRulesCounts({ droppedRules: { local: ['a', 'b'], project: ['b'] } })).toEqual({ total: 2, local: 2, project: 1 });
  });
});

describe('broadRulesCounts', () => {
  it('counts the broad rules of both files; Clean up concerns the local ones', async () => {
    const { broadRulesCounts } = await import('../../src/renderer/logic');
    expect(broadRulesCounts({})).toEqual({ total: 0, local: 0, project: 0 });
    expect(broadRulesCounts({ broadRules: { local: ['Artifact'], project: ['Artifact', 'AskUserQuestion'] } })).toEqual({ total: 2, local: 1, project: 2 });
  });
});

describe('leftover processes (health popover)', () => {
  it('shows the time of day for today and the date for an earlier day', async () => {
    const { leftoverStartedLabel } = await import('../../src/renderer/logic');
    const now = new Date(2026, 10, 19, 15, 0, 0);
    const today = leftoverStartedLabel(new Date(2026, 10, 19, 10, 42, 0).getTime(), now);
    const earlier = leftoverStartedLabel(new Date(2026, 10, 17, 10, 42, 0).getTime(), now);
    expect(today).toMatch(/10[:.]42/);
    expect(earlier).not.toBe(today);
    expect(earlier).toMatch(/17/);
    expect(leftoverStartedLabel(Number.NaN, now)).toBe('');
  });
  it('leftoverOnly: yellow because of them alone, so no Sync button', async () => {
    const { leftoverOnly } = await import('../../src/renderer/logic');
    const base = { color: 'yellow' as const, leftoverProcesses: [{ pid: 9, startedAt: 1 }], ahead: 0, behind: 0, autoPushFailing: false };
    expect(leftoverOnly(base)).toBe(true);
    expect(leftoverOnly({ ...base, ahead: 1 })).toBe(false);
    expect(leftoverOnly({ ...base, autoPushFailing: true })).toBe(false);
    expect(leftoverOnly({ ...base, leftoverProcesses: [] })).toBe(false);
    expect(leftoverOnly({ ...base, color: 'red' })).toBe(false);
  });
});
