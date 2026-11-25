import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conditionHolds, daysBetween, languageCode, parseTips, renderTip, selectTip, selectTips, tipApplies, whenHolds, type HqFacts, type Tip } from '../../src/main/tips/tips';

const released = fs.readFileSync(path.join(__dirname, '../fixtures/tips/tips.yaml'), 'utf8');

const facts = (over: Partial<HqFacts> = {}): HqFacts => ({
  today: '2026-03-10',
  frameworkVersion: '0.21.0',
  pluginVersion: '0.21.0',
  cosName: 'Nora',
  chatLanguage: 'en',
  pending: [],
  lastUpdated: '2026-03-09',
  lastBriefDate: '2026-03-08',
  hqSetupDate: '2026-01-01',
  exists: () => true,
  hasOrgIcon: true,
  ...over,
});

const tip = (over: Partial<Tip> = {}): Tip => ({ id: 't', since: '0.14.0', pending: false, when: { always: true }, text: 'Text', phrase: 'Phrase', translations: {}, ...over });
const ok = (code: string, since: string | null = null) => ({ code, action: 'ok' as const, since });

describe('parseTips', () => {
  it('reads the released plugin file', () => {
    const tips = parseTips(released);
    expect(tips.length).toBeGreaterThanOrEqual(10);
    const approve = tips.find((x) => x.id === 'approve-several')!;
    expect(approve).toMatchObject({ since: '0.14.0', pending: false, when: { pending: { kind: 'ok', min: 3 } }, phrase: 'Approve {codes}' });
    expect(tips.find((x) => x.id === 'draft-in-your-voice')).toMatchObject({ pending: true, since: null });
  });
  it('gives no tips for a bad file, another schema or no list', () => {
    expect(parseTips('')).toEqual([]);
    expect(parseTips(':\n  - [')).toEqual([]);
    expect(parseTips('schema: tips/2\ntips: []')).toEqual([]);
    expect(parseTips('schema: tips/1\ntips: nope')).toEqual([]);
  });
  it('skips tips that are not valid and keeps the rest', () => {
    const y = `schema: tips/1
tips:
  - {id: Bad_Id, since: "0.1.0", when: {always: true}, text: a, phrase: b}
  - {id: no-phrase, since: "0.1.0", when: {always: true}, text: a}
  - {id: no-when, since: "0.1.0", text: a, phrase: b}
  - {id: empty-when, since: "0.1.0", when: {}, text: a, phrase: b}
  - {id: good, since: "0.1.0", when: {file_missing: x}, text: a, phrase: b}
  - {id: good, since: "0.1.0", when: {file_missing: y}, text: dup, phrase: dup}
  - 5
`;
    expect(parseTips(y).map((x) => x.id)).toEqual(['good']);
  });
  it('keeps valid translations and drops those whose placeholders differ from the source', () => {
    const y = `schema: tips/1
tips:
  - id: resume
    since: "0.14.0"
    when: {days_since_last_session: {min: 7}}
    text: "Ask {cos_name}."
    phrase: "Resume"
    translations:
      it: {text: "Chiedi a {cos_name}.", phrase: "Riprendi"}
      fr: {text: "Demandez.", phrase: "Reprendre"}
      de: {text: "Frag {cos_name}.", phrase: "Weiter"}
      zzz: {text: "x", phrase: "y"}
`;
    const [t] = parseTips(y);
    expect(Object.keys(t.translations)).toEqual(['it', 'de']);
  });
});

describe('dates', () => {
  it('counts whole days and rejects non-dates', () => {
    expect(daysBetween('2026-03-01', '2026-03-10')).toBe(9);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-02-30', '2026-03-01')).toBeNull();
    expect(daysBetween('yesterday', '2026-03-01')).toBeNull();
  });
});

describe('conditions', () => {
  it('pending: counts items of that kind, children included', () => {
    const f = facts({ pending: [ok('X-A1'), ok('X-A2'), { code: 'X-D1', action: 'decide', since: null }] });
    expect(conditionHolds('pending', { kind: 'ok', min: 2 }, f)).toBe(true);
    expect(conditionHolds('pending', { kind: 'ok', min: 3 }, f)).toBe(false);
    expect(conditionHolds('pending', { kind: 'decide', min: 1 }, f)).toBe(true);
    expect(conditionHolds('pending', { kind: 'do', min: 1 }, f)).toBe(false);
  });
  it('pending: a malformed value never holds', () => {
    const f = facts({ pending: [ok('X-A1')] });
    for (const bad of [{ kind: 'wait', min: 1 }, { kind: 'ok', min: 0 }, { kind: 'ok' }, { kind: 'ok', min: 1, extra: 1 }, 'ok', null]) expect(conditionHolds('pending', bad, f)).toBe(false);
  });
  it('days_since_last_session: from last_updated, at least min days', () => {
    expect(conditionHolds('days_since_last_session', { min: 7 }, facts({ lastUpdated: '2026-03-03' }))).toBe(true);
    expect(conditionHolds('days_since_last_session', { min: 7 }, facts({ lastUpdated: '2026-03-04' }))).toBe(false);
    expect(conditionHolds('days_since_last_session', { min: 7 }, facts({ lastUpdated: null }))).toBe(false);
  });
  it('days_since_last_brief: newest brief, else the age of the hq from the setup record', () => {
    expect(conditionHolds('days_since_last_brief', { min: 7 }, facts({ lastBriefDate: '2026-03-01' }))).toBe(true);
    expect(conditionHolds('days_since_last_brief', { min: 7 }, facts({ lastBriefDate: '2026-03-08' }))).toBe(false);
    expect(conditionHolds('days_since_last_brief', { min: 7 }, facts({ lastBriefDate: null, hqSetupDate: '2026-03-09' }))).toBe(false);
    expect(conditionHolds('days_since_last_brief', { min: 7 }, facts({ lastBriefDate: null, hqSetupDate: '2026-02-01' }))).toBe(true);
    expect(conditionHolds('days_since_last_brief', { min: 7 }, facts({ lastBriefDate: null, hqSetupDate: null }))).toBe(false);
  });
  it('hq_behind_plugin: framework version lower than the installed plugin', () => {
    expect(conditionHolds('hq_behind_plugin', true, facts({ frameworkVersion: '0.20.0', pluginVersion: '0.21.0' }))).toBe(true);
    expect(conditionHolds('hq_behind_plugin', true, facts({ frameworkVersion: '0.21.0', pluginVersion: '0.21.0' }))).toBe(false);
    expect(conditionHolds('hq_behind_plugin', true, facts({ frameworkVersion: '0.20.0', pluginVersion: null }))).toBe(false);
    expect(conditionHolds('hq_behind_plugin', false, facts({ frameworkVersion: '0.20.0' }))).toBe(false);
  });
  it('file_missing: a relative path inside the hq that does not exist', () => {
    const f = facts({ exists: (p) => p !== 'company/ceo-voice.md' });
    expect(conditionHolds('file_missing', 'company/ceo-voice.md', f)).toBe(true);
    expect(conditionHolds('file_missing', 'company/state.md', f)).toBe(false);
    expect(conditionHolds('file_missing', '../outside', facts({ exists: () => false }))).toBe(false);
    expect(conditionHolds('file_missing', '/etc/passwd', facts({ exists: () => false }))).toBe(false);
  });
  it('app-side keys: always and org_icon_missing', () => {
    expect(conditionHolds('always', true, facts())).toBe(true);
    expect(conditionHolds('org_icon_missing', true, facts({ hasOrgIcon: false }))).toBe(true);
    expect(conditionHolds('org_icon_missing', true, facts({ hasOrgIcon: true }))).toBe(false);
  });
  it('chat signals and unknown keys hide the tip', () => {
    expect(conditionHolds('chat', 'vague-request', facts())).toBe(false);
    expect(conditionHolds('something_new', true, facts())).toBe(false);
    expect(whenHolds({ always: true, something_new: 1 }, facts())).toBe(false);
    expect(whenHolds({}, facts())).toBe(false);
  });
  it('all keys must hold', () => {
    expect(whenHolds({ always: true, org_icon_missing: true }, facts({ hasOrgIcon: false }))).toBe(true);
    expect(whenHolds({ always: true, org_icon_missing: true }, facts({ hasOrgIcon: true }))).toBe(false);
  });
});

describe('tipApplies', () => {
  it('never shows a pending tip, whatever its condition', () => {
    expect(tipApplies(tip({ pending: true, since: null }), facts())).toBe(false);
  });
  it('needs the hq framework version to reach `since`', () => {
    expect(tipApplies(tip({ since: '0.21.0' }), facts({ frameworkVersion: '0.21.0' }))).toBe(true);
    expect(tipApplies(tip({ since: '0.21.0' }), facts({ frameworkVersion: '0.20.9' }))).toBe(false);
    expect(tipApplies(tip({ since: '0.21.0' }), facts({ frameworkVersion: null }))).toBe(false);
    expect(tipApplies(tip({ since: null }), facts({ frameworkVersion: null }))).toBe(true);
  });
});

describe('placeholders', () => {
  const approve = (): Tip => tip({ id: 'approve', when: { pending: { kind: 'ok', min: 2 } }, text: 'Several wait.', phrase: 'Approve {codes}' });
  it('{codes}: the real open items of that kind, oldest since first, at most 3', () => {
    const f = facts({ pending: [ok('X-A5', '2026-03-05'), ok('X-A1', '2026-03-01'), ok('X-A9'), ok('X-A3', '2026-03-02'), ok('X-A4', '2026-03-04'), { code: 'X-D1', action: 'decide', since: '2026-02-01' }] });
    expect(renderTip(approve(), f)!.phrase).toBe('Approve X-A1, X-A3, X-A4');
  });
  it('{codes}: hidden when there is no matching item', () => {
    expect(renderTip(approve(), facts())).toBeNull();
  });
  it('{cos_name}: the display name, else "the chief of staff"', () => {
    const t = tip({ text: 'Ask {cos_name}.', phrase: 'Resume' });
    expect(renderTip(t, facts({ cosName: 'Nora' }))!.text).toBe('Ask Nora.');
    expect(renderTip(t, facts({ cosName: '' }))!.text).toBe('Ask the chief of staff.');
  });
  it('{decision_code}: the oldest open decision', () => {
    const f = facts({ pending: [{ code: 'X-D2', action: 'decide', since: '2026-03-02' }, { code: 'X-D1', action: 'decide', since: '2026-03-01' }] });
    expect(renderTip(tip({ phrase: 'Decide {decision_code}' }), f)!.phrase).toBe('Decide X-D1');
    expect(renderTip(tip({ phrase: 'Decide {decision_code}' }), facts())).toBeNull();
  });
  it('{department}, {initiative}, {repo} and unknown names cannot be filled: the tip is hidden', () => {
    for (const name of ['department', 'initiative', 'repo', 'nope']) expect(renderTip(tip({ phrase: `Do {${name}}` }), facts())).toBeNull();
  });
  it('"..." is not a placeholder', () => {
    expect(renderTip(tip({ phrase: 'Decide whether ...' }), facts())!.phrase).toBe('Decide whether ...');
  });
});

describe('language', () => {
  const t = tip({ text: 'Hello {cos_name}', phrase: 'Resume', translations: { it: { text: 'Ciao {cos_name}', phrase: 'Riprendi' } } });
  it('uses the translation of the chat language, with filled values', () => {
    expect(renderTip(t, facts({ chatLanguage: 'it' }))).toEqual({ id: 't', text: 'Ciao Nora', phrase: 'Riprendi' });
    expect(renderTip(t, facts({ chatLanguage: 'it-IT' }))!.phrase).toBe('Riprendi');
    expect(renderTip(t, facts({ chatLanguage: 'IT' }))!.phrase).toBe('Riprendi');
  });
  it('shows English when there is no translation, the language is English, or it is not a code', () => {
    expect(renderTip(t, facts({ chatLanguage: 'fr' }))!.text).toBe('Hello Nora');
    expect(renderTip(t, facts({ chatLanguage: 'en' }))!.text).toBe('Hello Nora');
    expect(renderTip(t, facts({ chatLanguage: 'Italian' }))!.text).toBe('Hello Nora');
    expect(renderTip(t, facts({ chatLanguage: '' }))!.text).toBe('Hello Nora');
  });
  it('languageCode', () => {
    expect(languageCode('pt_BR')).toBe('pt');
    expect(languageCode('Italian')).toBeNull();
  });
});

describe('selectTip', () => {
  const a = tip({ id: 'a', text: 'A' });
  const b = tip({ id: 'b', text: 'B' });
  const c = tip({ id: 'c', text: 'C', when: { chat: 'vague-request' } });
  it('none when nothing applies', () => {
    expect(selectTip([c], facts(), new Set())).toBeNull();
    expect(selectTip([], facts(), new Set())).toBeNull();
  });
  it('rotates by day of the month over the candidates in file order, skipping the ones that do not apply', () => {
    expect(selectTip([a, c, b], facts({ today: '2026-03-10' }), new Set())!.id).toBe('a');
    expect(selectTip([a, c, b], facts({ today: '2026-03-11' }), new Set())!.id).toBe('b');
  });
  it('selectTips lists every candidate from the day pick on, wrapping, so the first is the tip selectTip gives', () => {
    expect(selectTips([a, c, b], facts({ today: '2026-03-10' }), new Set()).map((x) => x.id)).toEqual(['a', 'b']);
    expect(selectTips([a, c, b], facts({ today: '2026-03-11' }), new Set()).map((x) => x.id)).toEqual(['b', 'a']);
    expect(selectTips([a, b], facts(), new Set(['a', 'b']))).toEqual([]);
  });
  it('skips dismissed tips and a tip whose placeholders cannot be filled', () => {
    expect(selectTip([a, b], facts({ today: '2026-03-10' }), new Set(['a']))!.id).toBe('b');
    expect(selectTip([a, b], facts(), new Set(['a', 'b']))).toBeNull();
    const needs = tip({ id: 'n', phrase: 'Approve {codes}', when: { pending: { kind: 'ok', min: 1 } } });
    expect(selectTip([needs], facts(), new Set())).toBeNull();
  });
  it('works on the released file: nothing pending and fresh sessions means only tips that apply show', () => {
    const tips = parseTips(released);
    const f = facts({ pending: [ok('X-A1'), ok('X-A2'), ok('X-A3')], lastUpdated: '2026-03-09', lastBriefDate: '2026-03-09', frameworkVersion: '0.21.0', pluginVersion: '0.21.0', exists: () => true });
    expect(selectTip(tips, f, new Set())).toMatchObject({ id: 'approve-several', phrase: 'Approve X-A1, X-A2, X-A3' });
    // no pending, a stale session: only "resume" applies (cos name filled)
    const g = facts({ pending: [], lastUpdated: '2026-02-01', lastBriefDate: '2026-03-09', exists: () => true });
    expect(selectTip(tips, g, new Set())).toMatchObject({ id: 'resume', text: 'Back after a pause? Nora can pick up where you left off.' });
    // an hq older than the tips file gets no plugin tips (since not met)
    expect(selectTip(tips, facts({ frameworkVersion: '0.1.0', pending: [ok('X-A1'), ok('X-A2'), ok('X-A3')] }), new Set())).toBeNull();
  });
});
