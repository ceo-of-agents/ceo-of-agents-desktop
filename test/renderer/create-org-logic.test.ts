import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import en from '../../src/shared/strings/en.json';
import {
  agentNameFor,
  blankCustom,
  blankOwn,
  blankRepo,
  changePurposeOrLevel,
  emptyDraft,
  ERROR_KEYS,
  helpKey,
  QUESTION_KEYS,
  questionKey,
  questionsFor,
  STEP_IDS,
  stepsFor,
  suggestedId,
  summaryRows,
  todos,
  toAnswers,
  validateStep,
  type Draft,
  type StepId,
} from '../../src/renderer/create-org-logic';
import type { SetupData } from '../../src/shared/setup';

const table = en as Record<string, string>;

const gate = (id: string, tier: 'free' | 'notice' | 'ok', locked = false) => ({ id, tier, meaning: id, example: id, locked });
const data: SetupData = {
  pluginVersion: '0.18.0',
  catalog: [
    ...['engineering', 'design-brand', 'business', 'growth-social', 'legal', 'finance', 'tax', 'operations'].map((id) => ({ id, role: id[0].toUpperCase() + id.slice(1), purpose: '', advisory: ['legal', 'finance', 'tax'].includes(id), personalOnly: false })),
    ...['health', 'money', 'paperwork'].map((id) => ({ id, role: id[0].toUpperCase() + id.slice(1), purpose: '', advisory: true, personalOnly: true })),
  ],
  gates: [
    ...['issues-and-labels', 'comments', 'drafts', 'open-pr', 'research', 'hq-write'].map((id) => gate(id, 'free')),
    ...['push-non-deploy-branch', 'hq-commit', 'dispatch-pushing-department', 'merge'].map((id) => gate(id, 'notice')),
    ...['deploy', 'publish', 'contact-people', 'spend-money', 'rotate-secrets', 'delete-data', 'org-or-repo-settings', 'change-brand-rules', 'change-policy-rules'].map((id) => gate(id, 'ok')),
    gate('file-or-sign', 'ok', true),
    gate('make-payment', 'ok', true),
  ],
  tiers: ['opus', 'sonnet', 'haiku'],
};

const fixture = (name: string) => parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'setup-answers', `${name}.yaml`), 'utf8')) as Record<string, unknown>;

/** The answers the app does not collect are dropped from a plugin example before comparing. */
function comparable(a: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(a);
  delete out.services;
  out.destructive ??= 'deny';
  for (const d of (out.departments as Record<string, unknown>[]) ?? []) {
    delete d.changes;
    delete d.commands;
  }
  delete (out.names as Record<string, unknown>).agents;
  const pr = out.policies_repo as Record<string, unknown> | undefined;
  if (pr) delete pr.ceiling;
  const about = out.about as Record<string, string>;
  about.what = about.what.trim();
  about.why = about.why.trim();
  return out;
}

function productDraft(): Draft {
  const d = emptyDraft();
  d.language = { chat: 'en', files: 'en' };
  d.profile = 'technical';
  d.purpose = 'product';
  d.level = 'company';
  d.name = 'Acme';
  d.id = 'ACME';
  d.about = { what: '- A mobile app that helps small shops plan their week\n- For shop owners with fewer than ten employees', why: 'Shop owners lose hours every week to planning on paper.', stage: 'building' };
  d.catalog = ['engineering', 'legal'];
  d.custom = [
    {
      id: 'support',
      role: 'Customer support',
      purpose: 'Answer shop owners and keep a list of recurring questions.',
      scope: 'Replies to incoming support email\nA list of the most frequent questions',
      triggers: 'A shop owner writes in\nA question comes up more than twice',
      exclusions: [{ item: 'Refunds and payments', owner: 'ceo' }],
      coreJob: 'Keep shop owners answered and turn repeated questions into help pages.',
    },
  ];
  d.own = [{ id: 'reviewer', name: 'some-plugin:reviewer', kind: 'agent', location: 'the plugin some-plugin', purpose: 'Review pull requests for style and risk.', useWhen: 'A pull request is ready for review', mustNot: [{ item: 'Merging pull requests', owner: 'ceo' }], replaces: 'none' }];
  d.names = { cos: 'Chief of staff', ceo: { mode: 'later', value: '' }, departments: { engineering: 'Max', legal: 'Legal', support: 'Sam', reviewer: 'Reviewer' } };
  d.gates.mode = 'accept';
  d.destructive = 'deny';
  d.models = { cos: 'opus', departments: 'opus', overrides: { support: 'sonnet' }, topWorkers: ['engineering'] };
  d.policy.mode = 'none';
  d.remoteHq = { mode: 'value', value: 'https://github.com/acme/acme-hq.git' };
  d.repos = {
    mode: 'list',
    items: [
      { slug: 'acme/acme-app', role: 'code', visibility: 'public', protected: false, exists: true },
      { slug: 'acme/acme-site', role: 'site', visibility: 'private', protected: true, exists: false },
    ],
  };
  d.issuesHome = 'acme/acme-app';
  d.roadmap = { mode: 'board', url: 'https://github.com/orgs/acme/projects/1', statusField: 'Status' };
  d.attribution.mode = 'default';
  d.enablePlugin = true;
  return d;
}

function personalDraft(): Draft {
  const d = emptyDraft();
  d.language = { chat: 'it', files: 'en' };
  d.profile = 'non-technical';
  d.purpose = 'personal';
  d.level = 'company';
  d.name = 'Me';
  d.id = 'ME';
  d.about = { what: '- My health appointments\n- My bills and savings\n- My documents and deadlines', why: 'To stop losing time and missing deadlines.', stage: 'setting up' };
  d.catalog = ['health', 'money', 'paperwork'];
  d.custom = [
    {
      id: 'travel',
      role: 'Travel',
      purpose: 'Keep trips, bookings and travel documents in order.',
      scope: 'Trip plans and booking confirmations\nPassport and visa deadlines',
      triggers: 'A trip is planned\nA travel document is about to expire',
      exclusions: [{ item: 'Booking or paying for anything', owner: 'ceo' }],
      coreJob: 'Keep every trip and its documents ready ahead of time.',
    },
  ];
  d.names = { cos: 'Chief of staff', ceo: { mode: 'later', value: '' }, departments: { health: 'Health', money: 'Money', paperwork: 'Paperwork', travel: 'Travel' } };
  d.gates.mode = 'accept';
  d.destructive = 'deny';
  d.models = { cos: 'opus', departments: 'sonnet', overrides: {}, topWorkers: [] };
  d.remoteHq = { mode: 'none', value: '' };
  d.attribution.mode = 'none';
  d.enablePlugin = true;
  return d;
}

function holdingDraft(): Draft {
  const d = emptyDraft();
  d.language = { chat: 'en', files: 'en' };
  d.profile = 'technical';
  d.purpose = 'company';
  d.level = 'holding';
  d.name = 'Acme Holding';
  d.id = 'ACMEHQ';
  d.profile = 'non-technical';
  d.about = { what: '- I want my companies to give me time for family\n- I want a steady income from them', why: 'A clear portfolio of companies, each with the same basic rules.', stage: 'starting' };
  d.catalog = ['legal', 'tax'];
  d.names = { cos: 'Chief of staff', ceo: { mode: 'later', value: '' }, departments: { legal: 'Legal', tax: 'Tax' } };
  d.gates = { mode: 'custom', stricter: { comments: 'notice' }, looser: {} };
  d.destructive = 'deny';
  d.models = { cos: 'opus', departments: 'opus', overrides: {}, topWorkers: [] };
  d.remoteHq = { mode: 'none', value: '' };
  d.policiesRepo = { path: '/home/me/acme/policies', remote: { mode: 'none', value: '' } };
  d.attribution.mode = 'later';
  d.enablePlugin = true;
  return d;
}

const allErrors = (d: Draft) => Object.fromEntries(STEP_IDS.map((s) => [s, validateStep(s, d, data)]));

describe('emptyDraft', () => {
  it('has nothing selected and every text blank', () => {
    const d = emptyDraft();
    expect(d.profile).toBeNull();
    expect(d.purpose).toBeNull();
    expect(d.level).toBeNull();
    expect(d.about.stage).toBeNull();
    expect(d.gates.mode).toBeNull();
    expect(d.destructive).toBeNull();
    expect(d.models.cos).toBeNull();
    expect(d.models.departments).toBeNull();
    expect(d.policy.mode).toBeNull();
    expect(d.names.ceo.mode).toBeNull();
    expect(d.remoteHq.mode).toBeNull();
    expect(d.repos.mode).toBeNull();
    expect(d.roadmap.mode).toBeNull();
    expect(d.attribution.mode).toBeNull();
    expect(d.enablePlugin).toBeNull();
    expect(d.hostedOn).toBeNull();
    expect([d.language.chat, d.language.files, d.name, d.id, d.about.what, d.about.why, d.names.cos, d.issuesHome]).toEqual(['', '', '', '', '', '', '', '']);
    expect(d.catalog).toEqual([]);
    expect(d.noDepartments).toBe(false);
  });
  it('is a fresh object each time', () => {
    expect(emptyDraft()).not.toBe(emptyDraft());
  });
});

describe('stepsFor', () => {
  const withPurpose = (purpose: Draft['purpose'], level: Draft['level'] = 'company') => ({ ...emptyDraft(), purpose, level });
  const without = (steps: StepId[], ...gone: StepId[]) => steps.filter((s) => !gone.includes(s));
  it('lists every step while the purpose is unknown', () => {
    expect(stepsFor(emptyDraft())).toEqual([...STEP_IDS]);
  });
  it('product, startup and company at company level: all steps', () => {
    for (const p of ['product', 'startup', 'company'] as const) expect(stepsFor(withPurpose(p))).toEqual([...STEP_IDS]);
  });
  it('job keeps the policy step (employer rules)', () => {
    expect(stepsFor(withPurpose('job'))).toEqual([...STEP_IDS]);
  });
  it('personal and holding have no policy step but keep repositories and attribution', () => {
    expect(stepsFor(withPurpose('personal'))).toEqual(without([...STEP_IDS], 'policy'));
    expect(stepsFor(withPurpose('company', 'holding'))).toEqual(without([...STEP_IDS], 'policy'));
    expect(stepsFor(withPurpose('personal'))).toContain('repos-attribution');
  });
  it('keeps the questions that apply on the repositories step', () => {
    expect(questionsFor('repos-attribution', withPurpose('personal'))).toEqual(['remote.hq', 'attribution', 'attribution.commit', 'attribution.pr']);
    expect(questionsFor('repos-attribution', withPurpose('company', 'holding'))).toEqual(['remote.hq', 'policies_repo.path', 'policies_repo.remote', 'attribution', 'attribution.commit', 'attribution.pr']);
    expect(questionsFor('repos-attribution', withPurpose('job'))).toEqual(['remote.hq', 'remote.hosted_on', ...QUESTION_KEYS['repos-attribution'].filter((k) => /^(repos|issues_home|roadmap|attribution)/.test(k))]);
    expect(questionsFor('policy', withPurpose('job'))).toEqual(['employer_rules']);
    expect(questionsFor('about', withPurpose('personal'))).toEqual(['about.what.personal', 'about.why.personal', 'about.stage.personal']);
  });
});

describe('validateStep', () => {
  it('asks for every required answer on an empty draft', () => {
    const d = emptyDraft();
    expect(Object.keys(validateStep('language-profile', d, data))).toEqual(['language.chat', 'ceo.profile']);
    expect(Object.keys(validateStep('purpose-level', d, data))).toEqual(['org.purpose']);
    expect(Object.keys(validateStep('name-id', d, data))).toEqual(['org.name', 'org.id']);
    expect(Object.keys(validateStep('file-language', d, data))).toEqual(['language.files']);
    expect(Object.keys(validateStep('departments', d, data))).toEqual(['departments']);
    expect(Object.keys(validateStep('gates', d, data))).toEqual(['gates', 'destructive']);
    expect(Object.keys(validateStep('models', d, data))).toEqual(['models.cos', 'models.departments']);
    expect(Object.keys(validateStep('summary', d, data))).toEqual(['enable_plugin']);
    expect(validateStep('folder', d, data)).toEqual({});
    for (const e of Object.values(validateStep('about', d, data))) expect(e).toBe('createOrg.err.required');
  });
  it('asks the level only for purpose company', () => {
    expect(validateStep('purpose-level', { ...emptyDraft(), purpose: 'company' }, data)).toEqual({ 'org.level': 'createOrg.err.required' });
    expect(validateStep('purpose-level', { ...emptyDraft(), purpose: 'product', level: 'company' }, data)).toEqual({});
  });
  it('a complete product draft has no error on any step', () => {
    expect(Object.values(allErrors(productDraft())).every((e) => Object.keys(e).length === 0)).toBe(true);
  });
  it('a complete personal and a complete holding draft have no error', () => {
    for (const d of [personalDraft(), holdingDraft()]) expect(Object.values(allErrors(d)).every((e) => Object.keys(e).length === 0)).toBe(true);
  });
  it('checks the org id', () => {
    const d = productDraft();
    for (const bad of ['a', 'acme', '1ACME', 'ACMEACMEA', 'AC-ME']) expect(validateStep('name-id', { ...d, id: bad }, data)).toEqual({ 'org.id': 'createOrg.err.orgId' });
    for (const ok of ['AC', 'ACME', 'A1B2C3D4', 'ON']) expect(validateStep('name-id', { ...d, id: ok }, data)).toEqual({});
  });
  it('checks language codes', () => {
    const d = productDraft();
    expect(validateStep('language-profile', { ...d, language: { chat: 'English', files: 'en' } }, data)).toEqual({ 'language.chat': 'createOrg.err.language' });
    expect(validateStep('file-language', { ...d, language: { chat: 'en', files: 'E' } }, data)).toEqual({ 'language.files': 'createOrg.err.language' });
  });
  it('checks the stage against the purpose', () => {
    const d = productDraft();
    d.about.stage = 'settled';
    expect(validateStep('about', d, data)).toEqual({ 'about.stage': 'createOrg.err.stage' });
  });
  it('checks department ids: kebab-case, unique, not reserved, catalog known, personal only for personal', () => {
    const d = productDraft();
    d.custom[0].id = 'Customer Support';
    expect(validateStep('departments', d, data)['departments.custom.0.id']).toBe('createOrg.err.kebab');
    d.custom[0].id = 'engineering';
    expect(validateStep('departments', d, data)['departments.custom.0.id']).toBe('createOrg.err.idDuplicate');
    d.custom[0].id = 'worker';
    expect(validateStep('departments', d, data)['departments.custom.0.id']).toBe('createOrg.err.idReserved');
    d.custom[0].id = 'support';
    d.own[0].id = 'support';
    expect(validateStep('departments', d, data)['departments.own.0.id']).toBe('createOrg.err.idDuplicate');
    d.own[0].id = 'reviewer';
    d.catalog.push('health', 'nope');
    const e = validateStep('departments', d, data);
    expect(e['departments.catalog.2']).toBe('createOrg.err.unknownCatalog');
    expect(e['departments.catalog.3']).toBe('createOrg.err.unknownCatalog');
  });
  it('requires every field of a custom and an own department', () => {
    const d = emptyDraft();
    d.custom = [blankCustom()];
    d.own = [blankOwn()];
    const e = validateStep('departments', d, data);
    for (const k of ['id', 'role', 'purpose', 'scope', 'triggers', 'core_job', 'exclusions.0.item', 'exclusions.0.owner']) expect(e[`departments.custom.0.${k}`]).toBe('createOrg.err.required');
    for (const k of ['id', 'name', 'kind', 'location', 'purpose', 'use_when', 'replaces', 'must_not.0.item', 'must_not.0.owner']) expect(e[`departments.own.0.${k}`]).toBe('createOrg.err.required');
  });
  it('checks "none" against picks, own names and replaces', () => {
    const d = productDraft();
    d.noDepartments = true;
    expect(validateStep('departments', d, data).departments).toBe('createOrg.err.departmentsNone');
    d.noDepartments = false;
    d.own[0].name = 'some reviewer';
    d.own[0].replaces = 'legal';
    const e = validateStep('departments', d, data);
    expect(e['departments.own.0.name']).toBe('createOrg.err.ownName');
    expect(e['departments.own.0.replaces']).toBe('createOrg.err.replacesPicked');
    d.own[0].replaces = 'nope';
    expect(validateStep('departments', d, data)['departments.own.0.replaces']).toBe('createOrg.err.replaces');
    expect(validateStep('departments', { ...emptyDraft(), noDepartments: true }, data)).toEqual({});
  });
  it('derives agent names and catches a clash or an unusable name', () => {
    expect(agentNameFor('engineering', 'Engineering', 'engineering')).toBe('engineering');
    expect(agentNameFor('engineering', 'Engineering', 'Anna Maria')).toBe('anna-maria');
    expect(agentNameFor('engineering', 'Engineering', 'Zoë')).toBe('zoe');
    expect(agentNameFor('engineering', 'Engineering', '東京')).toBeNull();
    const d = productDraft();
    d.names.departments.support = 'Max';
    expect(validateStep('names', d, data)['names.departments.support']).toBe('createOrg.err.agentClash');
    expect(validateStep('names', d, data)['names.departments.engineering']).toBe('createOrg.err.agentClash');
    d.names.departments.support = '東京';
    expect(validateStep('names', d, data)['names.departments.support']).toBe('createOrg.err.agentName');
    d.names.departments.support = 'Worker';
    expect(validateStep('names', d, data)['names.departments.support']).toBe('createOrg.err.agentClash');
    d.names.departments.support = '';
    d.names.cos = ' ';
    d.names.ceo = emptyDraft().names.ceo;
    expect(validateStep('names', d, data)).toEqual({ 'names.cos': 'createOrg.err.required', 'names.ceo': 'createOrg.err.required', 'names.departments.support': 'createOrg.err.required' });
  });
  it('checks gate moves: known, never locked, toward ok or toward free, once', () => {
    const d = productDraft();
    d.gates = { mode: 'custom', stricter: {}, looser: {} };
    expect(validateStep('gates', d, data).gates).toBe('createOrg.err.gatesEmpty');
    d.gates = {
      mode: 'custom',
      stricter: { 'file-or-sign': 'ok', merge: 'free', nope: 'ok', comments: 'ok', deploy: 'ok' },
      looser: { 'make-payment': 'free', publish: 'ok', comments: 'free', 'hq-commit': 'free' },
    };
    const e = validateStep('gates', d, data);
    expect(e['gates.file-or-sign']).toBe('createOrg.err.gateLocked');
    expect(e['gates.make-payment']).toBe('createOrg.err.gateLocked');
    expect(e['gates.merge']).toBe('createOrg.err.gateStricter');
    expect(e['gates.nope']).toBe('createOrg.err.gateUnknown');
    expect(e['gates.deploy']).toBe('createOrg.err.gateStricter');
    expect(e['gates.publish']).toBe('createOrg.err.gateLooser');
    expect(e['gates.comments']).toBe('createOrg.err.gateTwice');
    expect(e['gates.hq-commit']).toBeUndefined();
  });
  it('checks model tiers, overrides and top workers', () => {
    const d = productDraft();
    d.models = { cos: 'gpt', departments: 'haiku', overrides: { reviewer: 'opus', ghost: 'opus', legal: 'turbo' }, topWorkers: ['reviewer', 'support', 'ghost'] };
    d.models.overrides.support = 'sonnet';
    const e = validateStep('models', d, data);
    expect(e['models.cos']).toBe('createOrg.err.tier');
    expect(e['models.departments']).toBeUndefined();
    expect(e['models.overrides.reviewer']).toBe('createOrg.err.overrideOwn');
    expect(e['models.overrides.ghost']).toBe('createOrg.err.unknownDepartment');
    expect(e['models.overrides.legal']).toBe('createOrg.err.tier');
    expect(e['models.top_workers.reviewer']).toBe('createOrg.err.topWorkersOwn');
    expect(e['models.top_workers.support']).toBe('createOrg.err.topWorkersOverride');
    expect(e['models.top_workers.ghost']).toBe('createOrg.err.unknownDepartment');
  });
  it('checks the holding policy and the employer rules', () => {
    const d = productDraft();
    expect(validateStep('policy', { ...d, policy: { mode: null, repo: '', local: '', pin: '' } }, data)).toEqual({ policy: 'createOrg.err.required' });
    expect(validateStep('policy', { ...d, policy: { mode: 'later', repo: '', local: '', pin: '' } }, data)).toEqual({});
    expect(validateStep('policy', { ...d, policy: { mode: 'repo', repo: '', local: '', pin: '' } }, data)).toEqual({ 'policy.local': 'createOrg.err.required', 'policy.pin': 'createOrg.err.required' });
    expect(validateStep('policy', { ...d, policy: { mode: 'repo', repo: '', local: '/p', pin: 'xyz' } }, data)).toEqual({ 'policy.pin': 'createOrg.err.pin' });
    expect(validateStep('policy', { ...d, policy: { mode: 'repo', repo: '', local: '/p', pin: '3f2a9c1' } }, data)).toEqual({});
    const job = { ...emptyDraft(), purpose: 'job' as const, level: 'company' as const };
    expect(validateStep('policy', job, data)).toEqual({ employer_rules: 'createOrg.err.required' });
    expect(validateStep('policy', { ...job, employerRules: { mode: 'value', value: '  ' } }, data)).toEqual({ employer_rules: 'createOrg.err.required' });
    expect(validateStep('policy', { ...job, employerRules: { mode: 'later', value: '' } }, data)).toEqual({});
  });
  it('checks the remotes, the policies repo path and hosted_on', () => {
    const d = holdingDraft();
    d.remoteHq = { mode: 'value', value: 'has space' };
    d.policiesRepo.path = 'relative/path';
    d.policiesRepo.remote = emptyDraft().remoteHq;
    expect(validateStep('repos-attribution', d, data)).toEqual({ 'remote.hq': 'createOrg.err.url', 'policies_repo.path': 'createOrg.err.absolute', 'policies_repo.remote': 'createOrg.err.required' });
    const job = { ...emptyDraft(), purpose: 'job' as const, level: 'company' as const, remoteHq: { mode: 'none' as const, value: '' }, attribution: { mode: 'default' as const, commit: '', pr: '' }, repos: { mode: 'none' as const, items: [] }, roadmap: { mode: 'none' as const, url: '', statusField: '' } };
    expect(validateStep('repos-attribution', job, data)).toEqual({ 'remote.hosted_on': 'createOrg.err.required' });
  });
  it('checks repos: slug format, unique, issues home, planned and the board', () => {
    const d = productDraft();
    d.repos.items = [{ ...blankRepo(), slug: 'acme' }, { ...blankRepo(), slug: 'acme/app', role: 'code', visibility: 'public', protected: true, exists: true }, { ...blankRepo(), slug: 'ACME/app', role: 'x', visibility: 'private', protected: false, exists: false }];
    d.issuesHome = 'other/repo';
    d.roadmap = { mode: 'board', url: 'https://example.com/x', statusField: '' };
    const e = validateStep('repos-attribution', d, data);
    expect(e['repos.0.slug']).toBe('createOrg.err.slug');
    for (const k of ['role', 'visibility', 'protected', 'exists']) expect(e[`repos.0.${k}`]).toBe('createOrg.err.required');
    expect(e['repos.2.slug']).toBe('createOrg.err.slugDuplicate');
    expect(e.issues_home).toBe('createOrg.err.issuesHome');
    expect(e['roadmap.url']).toBe('createOrg.err.boardUrl');
    expect(e['roadmap.status_field']).toBe('createOrg.err.required');
    d.repos.items = [];
    expect(validateStep('repos-attribution', d, data).repos).toBe('createOrg.err.reposEmpty');
  });
  it('issues home hq needs a GitHub hq remote', () => {
    const d = productDraft();
    d.issuesHome = 'hq';
    expect(validateStep('repos-attribution', d, data)).toEqual({});
    d.remoteHq = { mode: 'none', value: '' };
    expect(validateStep('repos-attribution', d, data).issues_home).toBe('createOrg.err.issuesHomeHq');
    d.remoteHq = { mode: 'value', value: 'git@github.com:acme/acme-hq.git' };
    expect(validateStep('repos-attribution', d, data)).toEqual({});
  });
  it('asks for the repos, the roadmap and the attribution, and both texts of an own attribution', () => {
    const d = productDraft();
    d.repos = { mode: null, items: [] };
    d.roadmap = { mode: null, url: '', statusField: '' };
    d.attribution = { mode: 'custom', commit: '', pr: ' ' };
    expect(validateStep('repos-attribution', d, data)).toEqual({ repos: 'createOrg.err.required', roadmap: 'createOrg.err.required', 'attribution.commit': 'createOrg.err.required', 'attribution.pr': 'createOrg.err.required' });
    d.attribution.mode = null;
    expect(validateStep('repos-attribution', d, data).attribution).toBe('createOrg.err.required');
    d.repos.mode = 'later';
    d.roadmap.mode = 'none';
    d.attribution.mode = 'later';
    expect(validateStep('repos-attribution', d, data)).toEqual({});
  });
  it('every error key it can return is in en.json', () => {
    for (const k of ERROR_KEYS) expect(table[k], k).toBeTruthy();
  });
});

describe('suggestedId', () => {
  it('suggests an id that matches the rule, or null', () => {
    expect(suggestedId('Acme')).toBe('ACME');
    expect(suggestedId('Acme Shop Planner')).toBe('ACME');
    expect(suggestedId('Élan Vital')).toBe('ELAN');
    expect(suggestedId('Supercalifragilistic')).toBe('SUPERCAL');
    expect(suggestedId('7up')).toBe('UP');
    expect(suggestedId('A b c')).toBe('ABC');
    expect(suggestedId('')).toBeNull();
    expect(suggestedId('東京')).toBeNull();
    expect(suggestedId('X')).toBeNull();
  });
});

describe('changePurposeOrLevel', () => {
  it('changes nothing and reports nothing when nothing is dropped', () => {
    const d = productDraft();
    const r = changePurposeOrLevel(d, { purpose: 'startup' });
    expect(r.affected).toBeNull();
    expect(r.draft.purpose).toBe('startup');
    expect(r.draft.about.stage).toBe('building');
    expect(d.purpose).toBe('product');
  });
  it('to personal drops policy, repos, issues home and roadmap, the stage and the answers there, and reports the first affected step', () => {
    const d = productDraft();
    const r = changePurposeOrLevel(d, { purpose: 'personal' });
    expect(r.draft.level).toBe('company');
    expect(r.draft.about.stage).toBeNull();
    expect(r.draft.repos).toEqual(emptyDraft().repos);
    expect(r.draft.issuesHome).toBe('');
    expect(r.draft.roadmap).toEqual(emptyDraft().roadmap);
    expect(r.draft.remoteHq.value).toBe('https://github.com/acme/acme-hq.git');
    expect(r.draft.catalog).toEqual(['engineering', 'legal']);
    expect(r.affected).toBe('about');
  });
  it('drops the repositories part when only that had answers', () => {
    const d = productDraft();
    d.purpose = 'job';
    d.about.stage = 'settled';
    d.hostedOn = 'personal';
    d.policy = emptyDraft().policy;
    const r = changePurposeOrLevel(d, { purpose: 'company', level: 'holding' });
    expect(r.draft.hostedOn).toBeNull();
    expect(r.draft.repos.mode).toBeNull();
    expect(r.affected).toBe('about');
    const r2 = changePurposeOrLevel({ ...d, about: { ...d.about, stage: 'starting' } }, { purpose: 'company', level: 'holding' });
    expect(r2.affected).toBe('repos-attribution');
    expect(r2.draft.about.stage).toBe('starting');
  });
  it('to job drops the policy; to holding drops the policy and the repos; away from holding drops the policies repo', () => {
    const d = productDraft();
    d.policy = { mode: 'repo', repo: '', local: '/p', pin: '3f2a9c1' };
    d.about.stage = 'settled';
    const toJob = changePurposeOrLevel(d, { purpose: 'job' });
    expect(toJob.draft.policy.mode).toBeNull();
    expect(toJob.draft.repos.mode).toBe('list');
    expect(toJob.affected).toBe('policy');
    const toHolding = changePurposeOrLevel(d, { purpose: 'company', level: 'holding' });
    expect(toHolding.draft.repos.mode).toBeNull();
    expect(toHolding.draft.roadmap.mode).toBeNull();
    expect(toHolding.affected).toBe('about');
    const h = holdingDraft();
    h.policiesRepo.path = '/x';
    const out = changePurposeOrLevel(h, { level: 'company' });
    expect(out.draft.policiesRepo).toEqual(emptyDraft().policiesRepo);
    expect(out.draft.about.stage).toBeNull();
    const out2 = changePurposeOrLevel({ ...h, about: { what: '', why: '', stage: 'starting' } }, { level: 'company' });
    expect(out2.affected).toBe('about');
  });
  it('drops employer rules and hosted_on when the purpose is no longer job', () => {
    const d = emptyDraft();
    d.purpose = 'job';
    d.level = 'company';
    d.employerRules = { mode: 'later', value: '' };
    d.hostedOn = 'employer';
    const r = changePurposeOrLevel(d, { purpose: 'product' });
    expect(r.draft.employerRules).toEqual(emptyDraft().employerRules);
    expect(r.draft.hostedOn).toBeNull();
    expect(r.affected).toBe('policy');
  });
  it('a purpose other than company sets the level to company; company asks it again', () => {
    const d = emptyDraft();
    expect(changePurposeOrLevel(d, { purpose: 'job' }).draft.level).toBe('company');
    const c = changePurposeOrLevel(d, { purpose: 'company' }).draft;
    expect(c.level).toBeNull();
    expect(changePurposeOrLevel(c, { level: 'holding' }).draft.level).toBe('holding');
    expect(changePurposeOrLevel({ ...c, level: 'holding' }, { purpose: 'company' }).draft.level).toBe('holding');
  });
  it('drops the personal-only departments, with their names and models, when the org is no longer personal', () => {
    const d = personalDraft();
    d.models.overrides = { health: 'haiku', travel: 'haiku' };
    d.models.topWorkers = ['money'];
    d.own = [{ ...blankOwn(), id: 'doc', replaces: 'paperwork' }];
    const r = changePurposeOrLevel(d, { purpose: 'product' });
    expect(r.draft.catalog).toEqual([]);
    expect(r.draft.names.departments).toEqual({ travel: 'Travel' });
    expect(r.draft.models.overrides).toEqual({ travel: 'haiku' });
    expect(r.draft.models.topWorkers).toEqual([]);
    expect(r.draft.own[0].replaces).toBeNull();
    expect(r.draft.custom).toHaveLength(1);
    expect(r.affected).toBe('about');
    const r2 = changePurposeOrLevel({ ...d, about: { ...d.about, stage: 'idea' } }, { purpose: 'product' });
    expect(r2.affected).toBe('departments');
  });
});

describe('toAnswers', () => {
  it('a full product draft equals the plugin example', () => {
    expect(toAnswers(productDraft())).toEqual(comparable(fixture('product')));
  });
  it('a full personal draft equals the plugin example', () => {
    expect(toAnswers(personalDraft())).toEqual(comparable(fixture('personal')));
  });
  it('a full holding draft equals the plugin example', () => {
    expect(toAnswers(holdingDraft())).toEqual(comparable(fixture('holding')));
  });
  it('keeps only what applies and trims text', () => {
    const d = personalDraft();
    d.policy = { mode: 'repo', repo: 'x', local: '/p', pin: 'abcdef1' };
    d.repos = { mode: 'later', items: [] };
    d.issuesHome = 'a/b';
    d.employerRules = { mode: 'later', value: '' };
    d.name = '  Me ';
    const a = toAnswers(d) as unknown as Record<string, unknown>;
    for (const k of ['policy', 'repos', 'issues_home', 'roadmap', 'employer_rules', 'policies_repo']) expect(a, k).not.toHaveProperty(k);
    expect((a.org as { name: string }).name).toBe('Me');
  });
  it('writes gates, attribution, own repos and a job hq', () => {
    const d = productDraft();
    d.gates = { mode: 'custom', stricter: { merge: 'ok' }, looser: { publish: 'notice' } };
    d.attribution = { mode: 'custom', commit: ' c ', pr: 'p' };
    d.destructive = 'ask';
    d.policy = { mode: 'repo', repo: '', local: '/p', pin: '3f2a9c1' };
    const a = toAnswers(d);
    expect(a.gates).toEqual({ stricter: { merge: 'ok' }, looser: { publish: 'notice' } });
    expect(a.attribution).toEqual({ commit: 'c', pr: 'p' });
    expect(a.destructive).toBe('ask');
    expect(a.policy).toEqual({ repo: '', local: '/p', pin: '3f2a9c1' });
    const job = { ...emptyDraft(), ...personalDraft(), purpose: 'job' as const, employerRules: { mode: 'value' as const, value: 'https://intranet.example.com/rules' }, hostedOn: 'personal' as const };
    job.about.stage = 'settled';
    const j = toAnswers(job);
    expect(j.employer_rules).toBe('https://intranet.example.com/rules');
    expect(j.remote).toEqual({ hq: 'none', hosted_on: 'personal' });
  });
});

describe('todos', () => {
  it('has none when nothing is deferred and every repo exists', () => {
    const d = productDraft();
    d.names.ceo = { mode: 'value', value: 'Gio' };
    d.repos.items[1].exists = true;
    expect(todos(d)).toEqual([]);
  });
  it('one low item per deferred answer and one normal item per planned repo', () => {
    const d = productDraft();
    const t = todos(d);
    expect(t).toEqual([
      { kind: 'deferred', urgency: 'low', label: 'createOrg.todo.deferred.names.ceo', vars: {} },
      { kind: 'repo-missing', urgency: 'normal', label: 'createOrg.todo.repoMissing', vars: { slug: 'acme/acme-site', visibility: 'private' } },
    ]);
    d.policy.mode = 'later';
    d.remoteHq = { mode: 'later', value: '' };
    d.roadmap.mode = 'later';
    d.attribution.mode = 'later';
    expect(todos(d).filter((x) => x.kind === 'deferred').map((x) => x.label.replace('createOrg.todo.deferred.', ''))).toEqual(['names.ceo', 'policy', 'remote.hq', 'roadmap', 'attribution']);
    d.repos = { mode: 'later', items: [] };
    expect(todos(d).map((x) => x.label.replace('createOrg.todo.deferred.', ''))).toContain('repos');
    expect(todos(d).some((x) => x.kind === 'repo-missing')).toBe(false);
  });
  it('counts only what applies to the purpose', () => {
    const h = holdingDraft();
    h.policiesRepo.remote = { mode: 'later', value: '' };
    h.policy.mode = 'later';
    h.repos.mode = 'later';
    expect(todos(h).map((x) => x.label.replace('createOrg.todo.deferred.', ''))).toEqual(['names.ceo', 'policies_repo.remote', 'attribution']);
    const job = { ...emptyDraft(), purpose: 'job' as const, level: 'company' as const, employerRules: { mode: 'later' as const, value: '' } };
    expect(todos(job).map((x) => x.label)).toEqual(['createOrg.todo.deferred.employer_rules']);
  });
  it('every todo label is in en.json', () => {
    const d = productDraft();
    d.policy.mode = 'later';
    d.remoteHq.mode = 'later';
    d.roadmap.mode = 'later';
    d.attribution.mode = 'later';
    for (const x of todos(d)) expect(table[x.label], x.label).toBeTruthy();
    for (const k of ['names.ceo', 'employer_rules', 'policy', 'remote.hq', 'policies_repo.remote', 'repos', 'roadmap', 'attribution']) expect(table[`createOrg.todo.deferred.${k}`]).toBeTruthy();
    expect(table['createOrg.todo.policyLoosening']).toBeTruthy();
  });
});

describe('summaryRows', () => {
  it('has a block per step with answers, deferred ones flagged', () => {
    const blocks = summaryRows(productDraft(), data);
    expect(blocks.map((b) => b.step)).toEqual(['language-profile', 'purpose-level', 'name-id', 'about', 'file-language', 'departments', 'names', 'gates', 'models', 'policy', 'repos-attribution', 'summary']);
    const names = blocks.find((b) => b.step === 'names')!;
    expect(names.rows.find((r) => r.key === 'names.ceo')).toMatchObject({ later: true, valueKey: 'createOrg.later' });
    expect(names.rows.find((r) => r.key === 'names.cos')).toMatchObject({ value: 'Chief of staff', later: false });
    expect(blocks.find((b) => b.step === 'name-id')!.rows[1]).toMatchObject({ key: 'org.id', value: 'ACME', mono: true });
    expect(blocks.find((b) => b.step === 'departments')!.rows[0].value).toBe('Engineering (engineering)\nLegal (legal)\nCustomer support (support)\nsome-plugin:reviewer (reviewer)');
  });
  it('an empty draft has no rows with a value', () => {
    expect(summaryRows(emptyDraft(), data).flatMap((b) => b.rows).filter((r) => r.value !== '' || r.valueKey !== null)).toEqual([]);
  });
  it('about rows use the question variant of the purpose', () => {
    const rows = summaryRows(personalDraft(), data).find((b) => b.step === 'about')!.rows;
    expect(rows.map((r) => r.key)).toEqual(['about.what.personal', 'about.why.personal', 'about.stage.personal']);
  });
  it('every key and option label it returns is in en.json', () => {
    for (const d of [productDraft(), personalDraft(), holdingDraft()]) {
      for (const b of summaryRows(d, data)) for (const r of b.rows) {
        expect(table[questionKey(r.key)], r.key).toBeTruthy();
        if (r.valueKey) expect(table[r.valueKey], r.valueKey).toBeTruthy();
      }
    }
  });
});

describe('QUESTION_KEYS', () => {
  it('every question has a label and a help in en.json', () => {
    for (const keys of Object.values(QUESTION_KEYS)) {
      for (const k of keys) {
        expect(table[questionKey(k)], questionKey(k)).toBeTruthy();
        expect(table[helpKey(k)] !== undefined, helpKey(k)).toBe(true);
      }
    }
  });
  it('covers every step and the section 14 chrome keys exist', () => {
    expect(Object.keys(QUESTION_KEYS)).toEqual([...STEP_IDS]);
    for (const k of ['sidebar.addOrg', 'addOrg.create', 'welcome.create', 'createOrg.title', 'createOrg.step', 'createOrg.terminal', 'createOrg.purposeChanged']) expect(table[k], k).toBeTruthy();
    expect(table['createOrg.step']).toBe('Step {n} of {total}');
  });
});
