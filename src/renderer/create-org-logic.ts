// Pure logic of the "Create a new org" wizard screens: the in-memory draft, the steps that apply, the checks on Next,
// what a purpose or level change drops, the answers file, the to-dos the CLI wizard would add and the summary rows.
// The questions, their order and their rules come from the plugin (skills/init-fleet/SKILL.md, schemas/setup-answers.yaml); this
// module holds no question wording: it returns i18n keys (`createOrg.q.<schemaKey>`, `createOrg.h.<schemaKey>`, `createOrg.err.*`, `createOrg.o.*`).
import type { GateTier, ModelTier, OrgLevel, OrgPurpose, SetupAnswers, SetupData, SetupDepartment, SetupRepo } from '../shared/setup';
import { cleanAnswers, SETUP_SCHEMA } from '../shared/setup';

// ---------- the draft ----------

/** A free answer that may be `none`, deferred (`later`) or a value. `null` = not answered. */
export interface Deferrable {
  mode: 'none' | 'later' | 'value' | null;
  value: string;
}

export interface DraftOwned {
  item: string;
  owner: string;
}

export interface DraftCustom {
  id: string;
  role: string;
  purpose: string;
  /** One item per line. */
  scope: string;
  /** One item per line. */
  triggers: string;
  exclusions: DraftOwned[];
  coreJob: string;
}

export interface DraftOwn {
  id: string;
  name: string;
  kind: 'agent' | 'skill' | null;
  location: string;
  purpose: string;
  /** One item per line. */
  useWhen: string;
  mustNot: DraftOwned[];
  /** A catalog id or `none`; null = not answered. */
  replaces: string | null;
}

export interface DraftRepo {
  slug: string;
  role: string;
  visibility: 'public' | 'private' | null;
  protected: boolean | null;
  exists: boolean | null;
}

export interface Draft {
  language: { chat: string; files: string };
  profile: 'technical' | 'non-technical' | null;
  purpose: OrgPurpose | null;
  /** Always `company` for a purpose other than company (not asked); asked for purpose company. */
  level: OrgLevel | null;
  name: string;
  id: string;
  about: { what: string; why: string; stage: string | null };
  /** Catalog ids picked, in the order picked. */
  catalog: string[];
  custom: DraftCustom[];
  own: DraftOwn[];
  /** The explicit answer "none" (no department). */
  noDepartments: boolean;
  names: { cos: string; ceo: Deferrable; departments: Record<string, string> };
  gates: { mode: 'accept' | 'custom' | null; stricter: Record<string, GateTier>; looser: Record<string, GateTier> };
  destructive: 'deny' | 'ask' | null;
  models: { cos: string | null; departments: string | null; overrides: Record<string, string>; topWorkers: string[] };
  policy: { mode: 'none' | 'later' | 'repo' | null; repo: string; local: string; pin: string };
  employerRules: Deferrable;
  remoteHq: Deferrable;
  hostedOn: 'personal' | 'employer' | 'undecided' | null;
  policiesRepo: { path: string; remote: Deferrable };
  repos: { mode: 'none' | 'later' | 'list' | null; items: DraftRepo[] };
  issuesHome: string;
  roadmap: { mode: 'none' | 'later' | 'board' | null; url: string; statusField: string };
  attribution: { mode: 'default' | 'none' | 'later' | 'custom' | null; commit: string; pr: string };
  enablePlugin: boolean | null;
}

const blankDeferrable = (): Deferrable => ({ mode: null, value: '' });

/** Nothing selected, every text blank. */
export function emptyDraft(): Draft {
  return {
    language: { chat: '', files: '' },
    profile: null,
    purpose: null,
    level: null,
    name: '',
    id: '',
    about: { what: '', why: '', stage: null },
    catalog: [],
    custom: [],
    own: [],
    noDepartments: false,
    names: { cos: '', ceo: blankDeferrable(), departments: {} },
    gates: { mode: null, stricter: {}, looser: {} },
    destructive: null,
    models: { cos: null, departments: null, overrides: {}, topWorkers: [] },
    policy: { mode: null, repo: '', local: '', pin: '' },
    employerRules: blankDeferrable(),
    remoteHq: blankDeferrable(),
    hostedOn: null,
    policiesRepo: { path: '', remote: blankDeferrable() },
    repos: { mode: null, items: [] },
    issuesHome: '',
    roadmap: { mode: null, url: '', statusField: '' },
    attribution: { mode: null, commit: '', pr: '' },
    enablePlugin: null,
  };
}

export const blankCustom = (): DraftCustom => ({ id: '', role: '', purpose: '', scope: '', triggers: '', exclusions: [{ item: '', owner: '' }], coreJob: '' });
export const blankOwn = (): DraftOwn => ({ id: '', name: '', kind: null, location: '', purpose: '', useWhen: '', mustNot: [{ item: '', owner: '' }], replaces: null });
export const blankRepo = (): DraftRepo => ({ slug: '', role: '', visibility: null, protected: null, exists: null });

// ---------- steps ----------

export const STEP_IDS = ['language-profile', 'purpose-level', 'name-id', 'about', 'file-language', 'departments', 'names', 'gates', 'models', 'policy', 'repos-attribution', 'summary', 'folder'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** The personal-life catalog entries: offered, and kept, only with purpose personal. */
export const PERSONAL_ONLY: readonly string[] = ['health', 'money', 'paperwork'];
export const PURPOSES: readonly OrgPurpose[] = ['job', 'product', 'startup', 'company', 'personal'];
export const LEVELS: readonly OrgLevel[] = ['company', 'holding'];
export const RESERVED_AGENTS: readonly string[] = ['reader', 'worker'];
const TIERS: readonly GateTier[] = ['free', 'notice', 'ok'];

/** What applies to the org's purpose and level (the schema's "Required by purpose and level"). An unanswered purpose applies nothing special. */
export function applicability(d: Pick<Draft, 'purpose' | 'level'>) {
  const holding = d.purpose === 'company' && d.level === 'holding';
  const p = d.purpose;
  return {
    holding,
    policy: !holding && (p === 'product' || p === 'startup' || p === 'company'),
    employerRules: p === 'job',
    hostedOn: p === 'job',
    policiesRepo: holding,
    repos: !holding && p !== null && p !== 'personal',
  };
}

/** The steps to list, in the wizard's order. Policy stays for a job (employer rules) and goes for a holding and personal; with no purpose yet every step is listed. */
export function stepsFor(d: Draft): StepId[] {
  const a = applicability(d);
  return STEP_IDS.filter((s) => s !== 'policy' || d.purpose === null || a.policy || a.employerRules);
}

/** The allowed answers to "what stage" for a purpose and level (schema `about.stage`). */
export function stagesFor(purpose: OrgPurpose | null, level: OrgLevel | null): string[] {
  if (purpose === 'job') return ['new in the role', 'settled', 'in transition'];
  if (purpose === 'personal') return ['setting up', 'running'];
  if (purpose === 'company' && level === 'holding') return ['starting', 'growing', 'steady'];
  if (purpose === 'product' || purpose === 'startup' || purpose === 'company') return ['idea', 'building', 'live'];
  return [];
}

/** The variant of the "what the org is about" questions: `holding`, `job`, `personal` or `product` (product, startup, company). */
export function aboutVariant(purpose: OrgPurpose | null, level: OrgLevel | null): 'product' | 'job' | 'holding' | 'personal' {
  if (purpose === 'job') return 'job';
  if (purpose === 'personal') return 'personal';
  if (purpose === 'company' && level === 'holding') return 'holding';
  return 'product';
}

// ---------- i18n keys ----------

export const questionKey = (schemaKey: string): string => `createOrg.q.${schemaKey}`;
export const helpKey = (schemaKey: string): string => `createOrg.h.${schemaKey}`;
/** The label key of a stage value (`new in the role` becomes `new-in-the-role`). */
export const stageKey = (stage: string): string => `createOrg.o.stage.${stage.replace(/\s+/g, '-')}`;

/** The schema keys asked on each step, in the wizard's order. The label of each is `createOrg.q.<key>` and its help `createOrg.h.<key>`. */
export const QUESTION_KEYS: Record<StepId, string[]> = {
  'language-profile': ['language.chat', 'ceo.profile'],
  'purpose-level': ['org.purpose', 'org.level'],
  'name-id': ['org.name', 'org.id'],
  about: ['about.what.product', 'about.why.product', 'about.stage.product', 'about.what.job', 'about.why.job', 'about.stage.job', 'about.what.holding', 'about.why.holding', 'about.stage.holding', 'about.what.personal', 'about.why.personal', 'about.stage.personal'],
  'file-language': ['language.files'],
  departments: [
    'departments',
    'departments.custom.id',
    'departments.custom.role',
    'departments.custom.purpose',
    'departments.custom.scope',
    'departments.custom.triggers',
    'departments.custom.exclusions',
    'departments.custom.core_job',
    'departments.own.id',
    'departments.own.name',
    'departments.own.kind',
    'departments.own.location',
    'departments.own.purpose',
    'departments.own.use_when',
    'departments.own.must_not',
    'departments.own.replaces',
    'departments.owner',
  ],
  names: ['names.cos', 'names.departments', 'names.ceo'],
  gates: ['gates', 'gates.stricter', 'gates.looser', 'destructive'],
  models: ['models.cos', 'models.departments', 'models.overrides', 'models.top_workers'],
  policy: ['policy', 'policy.repo', 'policy.local', 'policy.pin', 'employer_rules'],
  'repos-attribution': [
    'remote.hq',
    'policies_repo.path',
    'policies_repo.remote',
    'remote.hosted_on',
    'repos',
    'repos.slug',
    'repos.role',
    'repos.visibility',
    'repos.protected',
    'repos.exists',
    'issues_home',
    'roadmap',
    'roadmap.url',
    'roadmap.status_field',
    'attribution',
    'attribution.commit',
    'attribution.pr',
  ],
  summary: ['enable_plugin'],
  folder: [],
};

/** The questions of a step that apply to this draft (a variant or part that does not apply is left out). */
export function questionsFor(step: StepId, d: Draft): string[] {
  const a = applicability(d);
  const all = QUESTION_KEYS[step];
  if (step === 'about') {
    const v = aboutVariant(d.purpose, d.level);
    return all.filter((k) => k.endsWith(`.${v}`));
  }
  if (step === 'policy') return all.filter((k) => (k === 'employer_rules' ? a.employerRules : a.policy));
  if (step === 'repos-attribution') {
    return all.filter((k) => {
      if (k.startsWith('policies_repo')) return a.policiesRepo;
      if (k === 'remote.hosted_on') return a.hostedOn;
      if (k.startsWith('repos') || k === 'issues_home' || k.startsWith('roadmap')) return a.repos;
      return true;
    });
  }
  return all;
}

// ---------- error keys ----------

export const ERR = {
  required: 'createOrg.err.required',
  language: 'createOrg.err.language',
  orgId: 'createOrg.err.orgId',
  kebab: 'createOrg.err.kebab',
  idDuplicate: 'createOrg.err.idDuplicate',
  idReserved: 'createOrg.err.idReserved',
  unknownCatalog: 'createOrg.err.unknownCatalog',
  departmentsNone: 'createOrg.err.departmentsNone',
  ownName: 'createOrg.err.ownName',
  replaces: 'createOrg.err.replaces',
  replacesPicked: 'createOrg.err.replacesPicked',
  agentName: 'createOrg.err.agentName',
  agentClash: 'createOrg.err.agentClash',
  tier: 'createOrg.err.tier',
  gatesEmpty: 'createOrg.err.gatesEmpty',
  gateUnknown: 'createOrg.err.gateUnknown',
  gateLocked: 'createOrg.err.gateLocked',
  gateStricter: 'createOrg.err.gateStricter',
  gateLooser: 'createOrg.err.gateLooser',
  gateTwice: 'createOrg.err.gateTwice',
  overrideOwn: 'createOrg.err.overrideOwn',
  topWorkersOwn: 'createOrg.err.topWorkersOwn',
  topWorkersOverride: 'createOrg.err.topWorkersOverride',
  unknownDepartment: 'createOrg.err.unknownDepartment',
  pin: 'createOrg.err.pin',
  absolute: 'createOrg.err.absolute',
  url: 'createOrg.err.url',
  slug: 'createOrg.err.slug',
  slugDuplicate: 'createOrg.err.slugDuplicate',
  reposEmpty: 'createOrg.err.reposEmpty',
  issuesHome: 'createOrg.err.issuesHome',
  issuesHomeHq: 'createOrg.err.issuesHomeHq',
  boardUrl: 'createOrg.err.boardUrl',
  stage: 'createOrg.err.stage',
} as const;
export const ERROR_KEYS: string[] = Object.values(ERR);

// ---------- rules ----------

const ORG_ID = /^[A-Z][A-Z0-9]{1,7}$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LANG = /^[a-z]{2}$/;
const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PIN = /^[0-9a-f]{7,40}$/i;
const BOARD = /^https:\/\/github\.com\/(orgs|users)\/[A-Za-z0-9-]+\/projects\/[0-9]+$/;
const AGENT = /^[a-z][a-z0-9-]*$/;
const GITHUB_REMOTE = /github\.com[/:][A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/;

const blank = (s: string | null | undefined): boolean => !s || s.trim() === '';

/** A textarea answer as items: one per line, trimmed, blank lines dropped. */
export function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** An uppercase id suggestion that matches the id rule, or null. Never filled in for the CEO. */
export function suggestedId(name: string): string | null {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '');
  const clean = (s: string) => s.toUpperCase().replace(/^[0-9]+/, '');
  const first = clean(words[0] ?? '').slice(0, 8);
  const candidate = first.length >= 2 ? first : clean(words.map((w) => w[0]).join('')).slice(0, 8);
  return ORG_ID.test(candidate) ? candidate : null;
}

/** The agent name a department gets: the id when the display name equals the role name (ignoring case), else the persona slug. Null when nothing usable is left. */
export function agentNameFor(id: string, role: string, display: string): string | null {
  if (display.trim().toLowerCase() === role.trim().toLowerCase()) return id;
  const slug = display
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return AGENT.test(slug) ? slug : null;
}

export interface DepartmentEntry {
  id: string;
  from: 'catalog' | 'custom' | 'own';
  /** The role name (catalog role, custom role) or, for your own, its agent or skill name. */
  role: string;
}

/** The chosen departments in answer order: catalog picks, custom, own. */
export function departmentEntries(d: Draft, data?: SetupData): DepartmentEntry[] {
  return [
    ...d.catalog.map((id): DepartmentEntry => ({ id, from: 'catalog', role: data?.catalog.find((c) => c.id === id)?.role ?? id })),
    ...d.custom.map((c): DepartmentEntry => ({ id: c.id.trim(), from: 'custom', role: c.role.trim() })),
    ...d.own.map((o): DepartmentEntry => ({ id: o.id.trim(), from: 'own', role: o.name.trim() })),
  ];
}

/** The agent name of each chosen department (own: its own name), null where none can be derived. */
export function agentNames(d: Draft, data?: SetupData): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of departmentEntries(d, data)) {
    out[e.id] = e.from === 'own' ? e.role : agentNameFor(e.id, e.role, d.names.departments[e.id] ?? '');
  }
  return out;
}

type Errors = Record<string, string>;

function deferrable(errors: Errors, key: string, v: Deferrable, check?: (value: string) => string | null, allowLater = true): void {
  if (v.mode === null) errors[key] = ERR.required;
  else if (v.mode === 'later' && !allowLater) errors[key] = ERR.required;
  else if (v.mode === 'value') {
    if (blank(v.value)) errors[key] = ERR.required;
    else if (check) {
      const e = check(v.value.trim());
      if (e) errors[key] = e;
    }
  }
}

const urlCheck = (v: string): string | null => (/\s/.test(v) ? ERR.url : null);
const absoluteCheck = (v: string): string | null => (v.startsWith('/') ? null : ERR.absolute);

function validateOwned(errors: Errors, key: string, list: DraftOwned[]): void {
  if (list.length === 0) errors[key] = ERR.required;
  list.forEach((x, i) => {
    if (blank(x.item)) errors[`${key}.${i}.item`] = ERR.required;
    if (blank(x.owner)) errors[`${key}.${i}.owner`] = ERR.required;
  });
}

/** The tier rank: free < notice < ok. */
const rank = (t: string): number => TIERS.indexOf(t as GateTier);

function validateDepartments(d: Draft, data: SetupData, errors: Errors): void {
  const entries = departmentEntries(d, data);
  if (entries.length === 0 && !d.noDepartments) errors.departments = ERR.required;
  if (entries.length > 0 && d.noDepartments) errors.departments = ERR.departmentsNone;
  const ids = new Map<string, number>();
  for (const e of entries) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  d.catalog.forEach((id, i) => {
    const c = data.catalog.find((x) => x.id === id);
    if (!c || (c.personalOnly && d.purpose !== 'personal')) errors[`departments.catalog.${i}`] = ERR.unknownCatalog;
  });
  const idError = (id: string): string | null => {
    if (blank(id)) return ERR.required;
    if (!KEBAB.test(id.trim())) return ERR.kebab;
    if (RESERVED_AGENTS.includes(id.trim())) return ERR.idReserved;
    if ((ids.get(id.trim()) ?? 0) > 1) return ERR.idDuplicate;
    return null;
  };
  d.custom.forEach((c, i) => {
    const k = `departments.custom.${i}`;
    const e = idError(c.id);
    if (e) errors[`${k}.id`] = e;
    if (blank(c.role)) errors[`${k}.role`] = ERR.required;
    if (blank(c.purpose)) errors[`${k}.purpose`] = ERR.required;
    if (lines(c.scope).length === 0) errors[`${k}.scope`] = ERR.required;
    if (lines(c.triggers).length === 0) errors[`${k}.triggers`] = ERR.required;
    validateOwned(errors, `${k}.exclusions`, c.exclusions);
    if (blank(c.coreJob)) errors[`${k}.core_job`] = ERR.required;
  });
  d.own.forEach((o, i) => {
    const k = `departments.own.${i}`;
    const e = idError(o.id);
    if (e) errors[`${k}.id`] = e;
    if (blank(o.name)) errors[`${k}.name`] = ERR.required;
    else if (/\s/.test(o.name.trim()) || RESERVED_AGENTS.includes(o.name.trim())) errors[`${k}.name`] = ERR.ownName;
    if (o.kind === null) errors[`${k}.kind`] = ERR.required;
    if (blank(o.location)) errors[`${k}.location`] = ERR.required;
    if (blank(o.purpose)) errors[`${k}.purpose`] = ERR.required;
    if (lines(o.useWhen).length === 0) errors[`${k}.use_when`] = ERR.required;
    validateOwned(errors, `${k}.must_not`, o.mustNot);
    if (o.replaces === null) errors[`${k}.replaces`] = ERR.required;
    else if (o.replaces !== 'none') {
      const c = data.catalog.find((x) => x.id === o.replaces);
      if (!c || (c.personalOnly && d.purpose !== 'personal')) errors[`${k}.replaces`] = ERR.replaces;
      else if (d.catalog.includes(o.replaces)) errors[`${k}.replaces`] = ERR.replacesPicked;
    }
  });
}

function validateNames(d: Draft, data: SetupData, errors: Errors): void {
  if (blank(d.names.cos)) errors['names.cos'] = ERR.required;
  deferrable(errors, 'names.ceo', d.names.ceo);
  const entries = departmentEntries(d, data);
  const agents = agentNames(d, data);
  for (const e of entries) {
    const k = `names.departments.${e.id}`;
    if (blank(d.names.departments[e.id])) {
      errors[k] = ERR.required;
      continue;
    }
    const a = agents[e.id];
    if (a === null || !AGENT.test(a.replace(/:/g, '-'))) {
      errors[k] = ERR.agentName;
      continue;
    }
    const clash = RESERVED_AGENTS.includes(a) || entries.some((o) => o.id !== e.id && (o.id === a || agents[o.id] === a || agents[o.id] === e.id));
    if (clash) errors[k] = ERR.agentClash;
  }
}

function validateGates(d: Draft, data: SetupData, errors: Errors): void {
  if (d.gates.mode === null) errors.gates = ERR.required;
  if (d.gates.mode === 'custom') {
    const moves = (list: Record<string, GateTier>, kind: 'stricter' | 'looser') => {
      for (const [id, tier] of Object.entries(list)) {
        const k = `gates.${id}`;
        const action = data.gates.find((g) => g.id === id);
        if (!action) errors[k] = ERR.gateUnknown;
        else if (action.locked) errors[k] = ERR.gateLocked;
        else if (kind === 'stricter' && !(rank(tier) > rank(action.tier) && tier !== 'free')) errors[k] = ERR.gateStricter;
        else if (kind === 'looser' && !(rank(tier) < rank(action.tier) && tier !== 'ok')) errors[k] = ERR.gateLooser;
        else if (kind === 'looser' && id in d.gates.stricter) errors[k] = ERR.gateTwice;
      }
    };
    moves(d.gates.stricter, 'stricter');
    moves(d.gates.looser, 'looser');
    for (const id of Object.keys(d.gates.stricter)) if (id in d.gates.looser) errors[`gates.${id}`] = ERR.gateTwice;
    if (Object.keys(d.gates.stricter).length + Object.keys(d.gates.looser).length === 0) errors.gates = ERR.gatesEmpty;
  }
  if (d.destructive === null) errors.destructive = ERR.required;
}

function validateModels(d: Draft, data: SetupData, errors: Errors): void {
  const tier = (key: string, v: string | null) => {
    if (v === null || v === '') errors[key] = ERR.required;
    else if (!data.tiers.includes(v)) errors[key] = ERR.tier;
  };
  tier('models.cos', d.models.cos);
  tier('models.departments', d.models.departments);
  const entries = departmentEntries(d, data);
  for (const [id, v] of Object.entries(d.models.overrides)) {
    const k = `models.overrides.${id}`;
    const e = entries.find((x) => x.id === id);
    if (!e) errors[k] = ERR.unknownDepartment;
    else if (e.from === 'own') errors[k] = ERR.overrideOwn;
    else tier(k, v);
  }
  for (const id of d.models.topWorkers) {
    const k = `models.top_workers.${id}`;
    const e = entries.find((x) => x.id === id);
    if (!e) errors[k] = ERR.unknownDepartment;
    else if (e.from === 'own') errors[k] = ERR.topWorkersOwn;
    else if (id in d.models.overrides) errors[k] = ERR.topWorkersOverride;
  }
}

function validatePolicy(d: Draft, errors: Errors): void {
  const a = applicability(d);
  if (a.employerRules) deferrable(errors, 'employer_rules', d.employerRules);
  if (a.policy) {
    if (d.policy.mode === null) errors.policy = ERR.required;
    if (d.policy.mode === 'repo') {
      if (/\s/.test(d.policy.repo.trim())) errors['policy.repo'] = ERR.url;
      if (blank(d.policy.local)) errors['policy.local'] = ERR.required;
      if (blank(d.policy.pin)) errors['policy.pin'] = ERR.required;
      else if (!PIN.test(d.policy.pin.trim())) errors['policy.pin'] = ERR.pin;
    }
  }
}

function validateRepos(d: Draft, errors: Errors): void {
  const a = applicability(d);
  deferrable(errors, 'remote.hq', d.remoteHq, urlCheck);
  if (a.policiesRepo) {
    if (blank(d.policiesRepo.path)) errors['policies_repo.path'] = ERR.required;
    else if (absoluteCheck(d.policiesRepo.path.trim())) errors['policies_repo.path'] = ERR.absolute;
    deferrable(errors, 'policies_repo.remote', d.policiesRepo.remote, urlCheck);
  }
  if (a.hostedOn && d.hostedOn === null) errors['remote.hosted_on'] = ERR.required;
  if (!a.repos) return;
  if (d.repos.mode === null) errors.repos = ERR.required;
  if (d.repos.mode === 'list') {
    if (d.repos.items.length === 0) errors.repos = ERR.reposEmpty;
    const slugs = d.repos.items.map((r) => r.slug.trim().toLowerCase());
    d.repos.items.forEach((r, i) => {
      const k = `repos.${i}`;
      if (blank(r.slug)) errors[`${k}.slug`] = ERR.required;
      else if (!SLUG.test(r.slug.trim())) errors[`${k}.slug`] = ERR.slug;
      else if (slugs.indexOf(r.slug.trim().toLowerCase()) !== i) errors[`${k}.slug`] = ERR.slugDuplicate;
      if (blank(r.role)) errors[`${k}.role`] = ERR.required;
      if (r.visibility === null) errors[`${k}.visibility`] = ERR.required;
      if (r.protected === null) errors[`${k}.protected`] = ERR.required;
      if (r.exists === null) errors[`${k}.exists`] = ERR.required;
    });
    const home = d.issuesHome.trim();
    if (home === '') errors.issues_home = ERR.required;
    else if (home === 'hq') {
      if (d.remoteHq.mode !== 'value' || !GITHUB_REMOTE.test(d.remoteHq.value.trim())) errors.issues_home = ERR.issuesHomeHq;
    } else if (!slugs.includes(home.toLowerCase())) errors.issues_home = ERR.issuesHome;
  }
  if (d.roadmap.mode === null) errors.roadmap = ERR.required;
  if (d.roadmap.mode === 'board') {
    if (blank(d.roadmap.url)) errors['roadmap.url'] = ERR.required;
    else if (!BOARD.test(d.roadmap.url.trim())) errors['roadmap.url'] = ERR.boardUrl;
    if (blank(d.roadmap.statusField)) errors['roadmap.status_field'] = ERR.required;
  }
}

/** The attribution question is asked for every level, on the repositories step. */
function validateAttribution(d: Draft, errors: Errors): void {
  if (d.attribution.mode === null) errors.attribution = ERR.required;
  if (d.attribution.mode === 'custom') {
    if (blank(d.attribution.commit)) errors['attribution.commit'] = ERR.required;
    if (blank(d.attribution.pr)) errors['attribution.pr'] = ERR.required;
  }
}

/** The errors on a step as field key to `createOrg.err.*` key; empty when the step is fine. Back never calls this. */
export function validateStep(step: StepId, d: Draft, data: SetupData): Record<string, string> {
  const errors: Errors = {};
  switch (step) {
    case 'language-profile':
      if (!LANG.test(d.language.chat.trim())) errors['language.chat'] = blank(d.language.chat) ? ERR.required : ERR.language;
      if (d.profile === null) errors['ceo.profile'] = ERR.required;
      break;
    case 'purpose-level':
      if (d.purpose === null) errors['org.purpose'] = ERR.required;
      else if (d.purpose === 'company' && d.level === null) errors['org.level'] = ERR.required;
      break;
    case 'name-id':
      if (blank(d.name)) errors['org.name'] = ERR.required;
      if (blank(d.id)) errors['org.id'] = ERR.required;
      else if (!ORG_ID.test(d.id.trim())) errors['org.id'] = ERR.orgId;
      break;
    case 'about': {
      if (blank(d.about.what)) errors['about.what'] = ERR.required;
      if (blank(d.about.why)) errors['about.why'] = ERR.required;
      if (d.about.stage === null) errors['about.stage'] = ERR.required;
      else if (!stagesFor(d.purpose, d.level).includes(d.about.stage)) errors['about.stage'] = ERR.stage;
      break;
    }
    case 'file-language':
      if (!LANG.test(d.language.files.trim())) errors['language.files'] = blank(d.language.files) ? ERR.required : ERR.language;
      break;
    case 'departments':
      validateDepartments(d, data, errors);
      break;
    case 'names':
      validateNames(d, data, errors);
      break;
    case 'gates':
      validateGates(d, data, errors);
      break;
    case 'models':
      validateModels(d, data, errors);
      break;
    case 'policy':
      validatePolicy(d, errors);
      break;
    case 'repos-attribution':
      validateRepos(d, errors);
      validateAttribution(d, errors);
      break;
    case 'summary':
      if (d.enablePlugin === null) errors.enable_plugin = ERR.required;
      break;
    case 'folder':
      break;
  }
  return errors;
}

// ---------- changing purpose or level ----------

export interface PurposePatch {
  purpose?: OrgPurpose;
  level?: OrgLevel | null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies a purpose or level change and drops the answers that no longer apply (what `cleanAnswers` drops, the stage when it is not
 * one of the new purpose's, and the department choices of the personal entries when the org is no longer personal).
 * `affected` is the first step, in wizard order, that had an answer dropped.
 */
export function changePurposeOrLevel(draft: Draft, patch: PurposePatch): { draft: Draft; affected: StepId | null } {
  const next = structuredClone(draft);
  const purpose = patch.purpose ?? draft.purpose;
  next.purpose = purpose;
  if (purpose === 'company') next.level = patch.level !== undefined ? patch.level : patch.purpose && patch.purpose !== draft.purpose ? null : draft.level;
  else next.level = purpose === null ? null : 'company';

  const fresh = emptyDraft();
  const dropped = new Set<StepId>();
  const a = applicability(next);

  if (next.about.stage !== null && !stagesFor(next.purpose, next.level).includes(next.about.stage)) {
    next.about.stage = null;
    dropped.add('about');
  }
  if (!a.policy && !same(next.policy, fresh.policy)) {
    next.policy = fresh.policy;
    dropped.add('policy');
  }
  if (!a.employerRules && !same(next.employerRules, fresh.employerRules)) {
    next.employerRules = fresh.employerRules;
    dropped.add('policy');
  }
  if (!a.hostedOn && next.hostedOn !== null) {
    next.hostedOn = null;
    dropped.add('repos-attribution');
  }
  if (!a.policiesRepo && !same(next.policiesRepo, fresh.policiesRepo)) {
    next.policiesRepo = fresh.policiesRepo;
    dropped.add('repos-attribution');
  }
  if (!a.repos && (!same(next.repos, fresh.repos) || next.issuesHome !== '' || !same(next.roadmap, fresh.roadmap))) {
    next.repos = fresh.repos;
    next.issuesHome = '';
    next.roadmap = fresh.roadmap;
    dropped.add('repos-attribution');
  }
  if (purpose !== 'personal') {
    const gone = next.catalog.filter((id) => PERSONAL_ONLY.includes(id));
    if (gone.length > 0) {
      next.catalog = next.catalog.filter((id) => !gone.includes(id));
      dropped.add('departments');
      for (const id of gone) {
        if (id in next.names.departments) {
          delete next.names.departments[id];
          dropped.add('names');
        }
        if (id in next.models.overrides) {
          delete next.models.overrides[id];
          dropped.add('models');
        }
        if (next.models.topWorkers.includes(id)) {
          next.models.topWorkers = next.models.topWorkers.filter((x) => x !== id);
          dropped.add('models');
        }
      }
      for (const o of next.own) if (o.replaces !== null && gone.includes(o.replaces)) o.replaces = null;
    }
  }
  const affected = STEP_IDS.find((s) => dropped.has(s)) ?? null;
  return { draft: next, affected };
}

// ---------- the answers file ----------

const deferred = (v: Deferrable): string => (v.mode === 'none' ? 'none' : v.mode === 'later' ? 'later' : v.value.trim());

/** The schema-valid answers for a draft whose steps all validate. */
export function toAnswers(d: Draft): SetupAnswers {
  const departments: SetupDepartment[] = [
    ...d.catalog.map((id): SetupDepartment => ({ from: 'catalog', id })),
    ...d.custom.map(
      (c): SetupDepartment => ({
        from: 'custom',
        id: c.id.trim(),
        role: c.role.trim(),
        purpose: c.purpose.trim(),
        scope: lines(c.scope),
        triggers: lines(c.triggers),
        exclusions: c.exclusions.map((x) => ({ item: x.item.trim(), owner: x.owner.trim() })),
        core_job: c.coreJob.trim(),
      }),
    ),
    ...d.own.map(
      (o): SetupDepartment => ({
        from: 'own',
        id: o.id.trim(),
        name: o.name.trim(),
        kind: o.kind ?? 'agent',
        location: o.location.trim(),
        purpose: o.purpose.trim(),
        use_when: lines(o.useWhen),
        must_not: o.mustNot.map((x) => ({ item: x.item.trim(), owner: x.owner.trim() })),
        replaces: o.replaces ?? 'none',
      }),
    ),
  ];
  const ids = departments.map((x) => x.id);
  const names: Record<string, string> = {};
  for (const id of ids) names[id] = (d.names.departments[id] ?? '').trim();
  const overrides: Record<string, ModelTier> = {};
  for (const [id, v] of Object.entries(d.models.overrides)) if (ids.includes(id)) overrides[id] = v as ModelTier;
  const topWorkers = d.models.topWorkers.filter((id) => ids.includes(id));
  const strip = (m: Record<string, GateTier>) => Object.fromEntries(Object.entries(m));

  const repos = d.repos.mode === 'list' ? d.repos.items.map((r): SetupRepo => ({ slug: r.slug.trim(), role: r.role.trim(), visibility: r.visibility ?? 'private', protected: r.protected ?? true, exists: r.exists ?? true })) : d.repos.mode ?? 'later';
  const roadmap = d.roadmap.mode === 'board' ? { url: d.roadmap.url.trim(), status_field: d.roadmap.statusField.trim() } : d.roadmap.mode ?? 'later';
  const attribution = d.attribution.mode === 'custom' ? { commit: d.attribution.commit.trim(), pr: d.attribution.pr.trim() } : d.attribution.mode ?? 'later';

  const answers: SetupAnswers = {
    schema: SETUP_SCHEMA,
    language: { chat: d.language.chat.trim(), files: d.language.files.trim() },
    org: { purpose: d.purpose ?? 'product', level: d.level ?? 'company', id: d.id.trim(), name: d.name.trim() },
    ceo: { profile: d.profile ?? 'non-technical' },
    about: { what: d.about.what.trim(), why: d.about.why.trim(), stage: d.about.stage ?? '' },
    departments,
    names: { cos: d.names.cos.trim(), ceo: deferred(d.names.ceo), departments: names },
    gates: d.gates.mode === 'custom' ? { ...(Object.keys(d.gates.stricter).length > 0 ? { stricter: strip(d.gates.stricter) } : {}), ...(Object.keys(d.gates.looser).length > 0 ? { looser: strip(d.gates.looser) } : {}) } : 'accept',
    destructive: d.destructive ?? 'deny',
    models: {
      cos: (d.models.cos ?? 'opus') as ModelTier,
      departments: (d.models.departments ?? 'opus') as ModelTier,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(topWorkers.length > 0 ? { top_workers: topWorkers } : {}),
    },
    policy: d.policy.mode === 'repo' ? { repo: d.policy.repo.trim(), local: d.policy.local.trim(), pin: d.policy.pin.trim() } : d.policy.mode ?? 'later',
    employer_rules: deferred(d.employerRules),
    remote: { hq: deferred(d.remoteHq), ...(d.hostedOn ? { hosted_on: d.hostedOn } : {}) },
    policies_repo: { path: d.policiesRepo.path.trim(), remote: deferred(d.policiesRepo.remote) },
    repos,
    issues_home: d.issuesHome.trim(),
    roadmap,
    attribution,
    enable_plugin: d.enablePlugin ?? false,
  };
  return cleanAnswers(answers);
}

// ---------- to-dos ----------

export interface Todo {
  kind: 'deferred' | 'repo-missing' | 'policy-loosening';
  urgency: 'high' | 'normal' | 'low';
  /** An i18n key (`createOrg.todo.*`); fill it with `vars`. */
  label: string;
  vars: Record<string, string>;
}

/**
 * The A items the CLI wizard would create (SKILL.md, generation step 12): one low item per deferred answer (the CEO name, the employer rules,
 * the holding policy, the hq remote, the policies repo remote, the product repos, the roadmap board, the attribution), one normal item per repo
 * that does not exist yet. A kept policy loosening (high) is found by the plugin's policy check during the run, which the app does not do: none here.
 */
export function todos(d: Draft): Todo[] {
  const a = applicability(d);
  const out: Todo[] = [];
  const later = (key: string) => out.push({ kind: 'deferred', urgency: 'low', label: `createOrg.todo.deferred.${key}`, vars: {} });
  if (d.names.ceo.mode === 'later') later('names.ceo');
  if (a.employerRules && d.employerRules.mode === 'later') later('employer_rules');
  if (a.policy && d.policy.mode === 'later') later('policy');
  if (d.remoteHq.mode === 'later') later('remote.hq');
  if (a.policiesRepo && d.policiesRepo.remote.mode === 'later') later('policies_repo.remote');
  if (a.repos && d.repos.mode === 'later') later('repos');
  if (a.repos && d.roadmap.mode === 'later') later('roadmap');
  if (d.attribution.mode === 'later') later('attribution');
  if (a.repos && d.repos.mode === 'list') {
    for (const r of d.repos.items) if (r.exists === false) out.push({ kind: 'repo-missing', urgency: 'normal', label: 'createOrg.todo.repoMissing', vars: { slug: r.slug.trim(), visibility: r.visibility ?? 'private' } });
  }
  return out;
}

// ---------- summary ----------

export interface SummaryRow {
  /** The schema key: the question is `createOrg.q.<key>` (for `about.*` use `about.<field>.<variant>`). */
  key: string;
  /** The answer as typed or chosen (an id, a slug, a path, free text; several items one per line). */
  value: string;
  /** When set, show `t(valueKey)` instead of `value` (an option's label). */
  valueKey: string | null;
  /** A deferred answer: the muted LATER chip and "Becomes a to-do in your hq.". */
  later: boolean;
  /** Ids, paths, slugs and URLs in the mono face. */
  mono: boolean;
}

export interface SummaryBlock {
  step: StepId;
  rows: SummaryRow[];
}

const row = (key: string, value: string, o: Partial<Pick<SummaryRow, 'valueKey' | 'later' | 'mono'>> = {}): SummaryRow => ({ key, value, valueKey: o.valueKey ?? null, later: o.later ?? false, mono: o.mono ?? false });
const choice = (key: string, group: string, v: string): SummaryRow => row(key, v, { valueKey: `createOrg.o.${group}.${v}` });
const defRow = (key: string, v: Deferrable, mono = true): SummaryRow =>
  v.mode === 'later' ? row(key, 'later', { valueKey: 'createOrg.later', later: true }) : v.mode === 'none' ? row(key, 'none', { valueKey: 'createOrg.o.none' }) : row(key, v.value.trim(), { mono });
const yesNo = (key: string, v: boolean | null): SummaryRow => row(key, v ? 'yes' : 'no', { valueKey: v ? 'createOrg.o.yes' : 'createOrg.o.no' });

/** The summary screen: one block per listed step that has answers, in wizard order. */
export function summaryRows(d: Draft, data: SetupData): SummaryBlock[] {
  const a = applicability(d);
  const v = aboutVariant(d.purpose, d.level);
  const blocks: SummaryBlock[] = [];
  const add = (step: StepId, rows: SummaryRow[]) => {
    if (rows.length > 0) blocks.push({ step, rows });
  };
  add('language-profile', [row('language.chat', d.language.chat.trim(), { mono: true }), ...(d.profile ? [choice('ceo.profile', 'profile', d.profile)] : [])]);
  add('purpose-level', [...(d.purpose ? [choice('org.purpose', 'purpose', d.purpose)] : []), ...(d.purpose === 'company' && d.level ? [choice('org.level', 'level', d.level)] : [])]);
  add('name-id', [row('org.name', d.name.trim()), row('org.id', d.id.trim(), { mono: true })]);
  add('about', [row(`about.what.${v}`, d.about.what.trim()), row(`about.why.${v}`, d.about.why.trim()), ...(d.about.stage ? [row(`about.stage.${v}`, d.about.stage, { valueKey: stageKey(d.about.stage) })] : [])]);
  add('file-language', [row('language.files', d.language.files.trim(), { mono: true })]);
  const entries = departmentEntries(d, data);
  add('departments', [entries.length > 0 ? row('departments', entries.map((e) => `${e.role} (${e.id})`).join('\n'), { mono: false }) : d.noDepartments ? row('departments', 'none', { valueKey: 'createOrg.o.none' }) : row('departments', '')]);
  const agents = agentNames(d, data);
  add('names', [
    row('names.cos', d.names.cos.trim()),
    ...(entries.length > 0 ? [row('names.departments', entries.map((e) => `${e.id}: ${d.names.departments[e.id]?.trim() ?? ''} (${agents[e.id] ?? ''})`).join('\n'))] : []),
    defRow('names.ceo', d.names.ceo, false),
  ]);
  const gateMoves = [...Object.entries(d.gates.stricter).map(([id, t]) => `${id}: ${t}`), ...Object.entries(d.gates.looser).map(([id, t]) => `${id}: ${t}`)];
  add('gates', [
    ...(d.gates.mode === 'custom' ? [row('gates', gateMoves.join('\n'), { mono: true })] : d.gates.mode === 'accept' ? [choice('gates', 'gates', 'accept')] : []),
    ...(d.destructive ? [choice('destructive', 'destructive', d.destructive)] : []),
  ]);
  add('models', [
    ...(d.models.cos ? [row('models.cos', d.models.cos, { valueKey: `createOrg.o.tier.${d.models.cos}` })] : []),
    ...(d.models.departments ? [row('models.departments', d.models.departments, { valueKey: `createOrg.o.tier.${d.models.departments}` })] : []),
    ...(Object.keys(d.models.overrides).length > 0 ? [row('models.overrides', Object.entries(d.models.overrides).map(([id, t]) => `${id}: ${t}`).join('\n'), { mono: true })] : []),
    ...(d.models.topWorkers.length > 0 ? [row('models.top_workers', d.models.topWorkers.join('\n'), { mono: true })] : []),
  ]);
  add('policy', [
    ...(a.employerRules ? [defRow('employer_rules', d.employerRules)] : []),
    ...(a.policy && d.policy.mode === 'repo' ? [row('policy', `${d.policy.repo.trim()} @ ${d.policy.pin.trim()}\n${d.policy.local.trim()}`.trim(), { mono: true })] : []),
    ...(a.policy && d.policy.mode === 'none' ? [row('policy', 'none', { valueKey: 'createOrg.o.none' })] : []),
    ...(a.policy && d.policy.mode === 'later' ? [row('policy', 'later', { valueKey: 'createOrg.later', later: true })] : []),
  ]);
  const repoRows: SummaryRow[] = [defRow('remote.hq', d.remoteHq)];
  if (a.policiesRepo) repoRows.push(row('policies_repo.path', d.policiesRepo.path.trim(), { mono: true }), defRow('policies_repo.remote', d.policiesRepo.remote));
  if (a.hostedOn && d.hostedOn) repoRows.push(choice('remote.hosted_on', 'hostedOn', d.hostedOn));
  if (a.repos) {
    if (d.repos.mode === 'list') {
      repoRows.push(row('repos', d.repos.items.map((r) => `${r.slug.trim()} (${r.role.trim()}, ${r.visibility ?? ''}${r.exists === false ? ', planned' : ''}${r.protected ? ', protected' : ''})`).join('\n'), { mono: true }));
      repoRows.push(row('issues_home', d.issuesHome.trim(), { mono: true }));
    } else if (d.repos.mode === 'later') repoRows.push(row('repos', 'later', { valueKey: 'createOrg.later', later: true }));
    else if (d.repos.mode === 'none') repoRows.push(row('repos', 'none', { valueKey: 'createOrg.o.none' }));
    if (d.roadmap.mode === 'board') repoRows.push(row('roadmap', `${d.roadmap.url.trim()}\n${d.roadmap.statusField.trim()}`, { mono: true }));
    else if (d.roadmap.mode === 'later') repoRows.push(row('roadmap', 'later', { valueKey: 'createOrg.later', later: true }));
    else if (d.roadmap.mode === 'none') repoRows.push(row('roadmap', 'none', { valueKey: 'createOrg.o.none' }));
  }
  if (d.attribution.mode === 'later') repoRows.push(row('attribution', 'later', { valueKey: 'createOrg.later', later: true }));
  else if (d.attribution.mode === 'custom') repoRows.push(row('attribution', `${d.attribution.commit.trim()}\n${d.attribution.pr.trim()}`));
  else if (d.attribution.mode) repoRows.push(choice('attribution', 'attribution', d.attribution.mode));
  add('repos-attribution', repoRows.filter((r) => r.value !== '' || r.valueKey !== null));
  add('summary', d.enablePlugin === null ? [] : [yesNo('enable_plugin', d.enablePlugin)]);
  return blocks;
}
