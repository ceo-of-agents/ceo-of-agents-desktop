// The "Create a new org" answers (mirrors the plugin's schema setup-answers/1, for what the app collects) and the plugin data the
// wizard screens show. Pure: no node or electron imports, used by the main process and the renderer.
import { Document, Scalar, visit } from 'yaml';

export const SETUP_SCHEMA = 'setup-answers/1';

export type OrgPurpose = 'job' | 'product' | 'startup' | 'company' | 'personal';
export type OrgLevel = 'company' | 'holding';
export type GateTier = 'free' | 'notice' | 'ok';
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

/** `{item, owner}`: something a department must not do or handle, and who does it instead. */
export interface OwnedItem {
  item: string;
  owner: string;
}

export interface CatalogDepartment {
  from: 'catalog';
  id: string;
}

export interface CustomDepartment {
  from: 'custom';
  id: string;
  role: string;
  purpose: string;
  scope: string[];
  triggers: string[];
  exclusions: OwnedItem[];
  core_job: string;
}

export interface OwnDepartment {
  from: 'own';
  id: string;
  name: string;
  kind: 'agent' | 'skill';
  location: string;
  purpose: string;
  use_when: string[];
  must_not: OwnedItem[];
  /** A catalog id of the same list, or `none`. */
  replaces: string;
}

export type SetupDepartment = CatalogDepartment | CustomDepartment | OwnDepartment;

export interface SetupRepo {
  slug: string;
  role: string;
  visibility: 'public' | 'private';
  protected: boolean;
  exists: boolean;
}

export type GatesAnswer = 'accept' | { stricter?: Record<string, GateTier>; looser?: Record<string, GateTier> };

export interface SetupAnswers {
  schema: typeof SETUP_SCHEMA;
  language: { chat: string; files: string };
  org: { purpose: OrgPurpose; level?: OrgLevel; id: string; name: string };
  ceo: { profile: 'technical' | 'non-technical' };
  about: { what: string; why: string; stage: string };
  departments: SetupDepartment[];
  names: { cos: string; ceo: string; departments: Record<string, string> };
  gates: GatesAnswer;
  destructive?: 'deny' | 'ask';
  models: { cos: ModelTier; departments: ModelTier; overrides?: Record<string, ModelTier>; top_workers?: string[] };
  policy?: 'none' | 'later' | { repo: string; local: string; pin: string };
  employer_rules?: string;
  remote: { hq: string; hosted_on?: 'personal' | 'employer' | 'undecided' };
  policies_repo?: { path: string; remote: string };
  repos?: 'none' | 'later' | SetupRepo[];
  issues_home?: string;
  roadmap?: 'none' | 'later' | { url: string; status_field: string };
  attribution: 'default' | 'none' | 'later' | { commit: string; pr: string };
  enable_plugin: boolean;
}

// ---------- plugin data shown by the wizard screens ----------

export interface CatalogEntry {
  id: string;
  role: string;
  purpose: string;
  advisory: boolean;
  /** Only offered when the org's purpose is personal. */
  personalOnly: boolean;
}

export interface GateAction {
  id: string;
  tier: GateTier;
  meaning: string;
  example: string;
  /** `file-or-sign` and `make-payment` can never move. */
  locked: boolean;
}

export interface SetupData {
  pluginVersion: string;
  catalog: CatalogEntry[];
  gates: GateAction[];
  /** Model tiers, most capable first. */
  tiers: string[];
}

/** Real milestones of a setup run, read from the new org's folder. */
export interface SetupFacts {
  /** org.yaml exists. */
  orgYaml: boolean;
  /** decisions/0001-*.md exists (the setup record). */
  decisionRecord: boolean;
  /** company/state.md exists. */
  state: boolean;
  /** .claude/settings.json exists. */
  settings: boolean;
  /** That settings file enables the plugin (an `enabledPlugins` key starting with `ceo-of-agents@` set to true). */
  pluginEnabled: boolean;
  /** Short sha of HEAD when the folder is a git repo with a commit, else null. */
  commit: string | null;
  /** org.name and the chief of staff's name from org.yaml, when it exists and holds them. */
  orgName: string | null;
  cosName: string | null;
}

export const EMPTY_FACTS: SetupFacts = { orgYaml: false, decisionRecord: false, state: false, settings: false, pluginEnabled: false, commit: null, orgName: null, cosName: null };

/** One setup run (the wizard talking in a new org's folder): what the renderer needs besides the thread. */
export interface SetupState {
  runId: string;
  /** A wizard turn is in flight. */
  busy: boolean;
  /** The Claude Code process ended (a next message starts it again and resumes the conversation). */
  exited: boolean;
  /** The folder now holds an hq (org.yaml and CLAUDE.md). */
  hqReady: boolean;
  /** What the folder holds now, detected from the folder only (never guessed from the conversation). */
  facts: SetupFacts;
  /** The answers file while the run is alive (deleted when it ends): the renderer shows it for the terminal fallback. */
  answersFile: string;
  /** The last turn failed: its message. */
  error: string | null;
}

export interface SetupFolderPick {
  path: string;
  ok: boolean;
  /** What blocks the folder (names inside it); empty when ok. */
  entries: string[];
  /** The folder, or `.git` or `.claude` in it, is a symbolic link: never accepted. */
  symlink?: boolean;
}

/** The org id every setup run has in thread events and permission requests; its thread id is `setupThreadId(runId)`. */
export const SETUP_ORG_ID = 'setup';
export const setupThreadId = (runId: string): `setup:${string}` => `setup:${runId}`;

// ---------- cleaning ----------

/** The keys that do not apply to the org's purpose and level are dropped (the schema's "Required by purpose and level"). */
export function cleanAnswers(a: SetupAnswers): SetupAnswers {
  const out: SetupAnswers = { ...a, remote: { ...a.remote } };
  const purpose = a.org.purpose;
  const holding = a.org.level === 'holding';
  const companyLevel = !holding;
  if (!(companyLevel && (purpose === 'product' || purpose === 'startup' || purpose === 'company'))) delete out.policy;
  if (purpose !== 'job') {
    delete out.employer_rules;
    delete out.remote.hosted_on;
  }
  if (!holding) delete out.policies_repo;
  if (!(companyLevel && purpose !== 'personal')) {
    delete out.repos;
    delete out.issues_home;
    delete out.roadmap;
  }
  if (!Array.isArray(out.repos)) delete out.issues_home;
  return out;
}

// ---------- YAML ----------

/** Words and shapes a YAML 1.1 reader (PyYAML and others) turns into a boolean, null or number. They are quoted. */
const YAML11_WORD = /^(y|n|yes|no|on|off|true|false|null|~)$/i;
const YAML11_NUMBER = /^[-+]?(\.?\d[\d_.,:eE+-]*|\.inf|\.nan|0[xob][0-9a-f_]+)$/i;
const YAML11_DATE = /^\d{4}-\d{1,2}-\d{1,2}/;

function needsQuotes(s: string): boolean {
  return s === '' || s !== s.trim() || YAML11_WORD.test(s) || YAML11_NUMBER.test(s) || YAML11_DATE.test(s);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_FOR_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

/** Keys in the order of the schema's annotated example; a key whose value is undefined is left out. */
function ordered(a: SetupAnswers): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) o[k] = v;
  };
  put('schema', SETUP_SCHEMA);
  put('language', { chat: a.language.chat, files: a.language.files });
  put('org', { purpose: a.org.purpose, ...(a.org.level ? { level: a.org.level } : {}), id: a.org.id, name: a.org.name });
  put('ceo', { profile: a.ceo.profile });
  put('about', { what: a.about.what, why: a.about.why, stage: a.about.stage });
  put('departments', a.departments.map(department));
  put('names', { cos: a.names.cos, ceo: a.names.ceo, departments: { ...a.names.departments } });
  put('gates', gates(a.gates));
  put('destructive', a.destructive);
  const m = a.models;
  put('models', {
    cos: m.cos,
    departments: m.departments,
    ...(m.overrides && Object.keys(m.overrides).length > 0 ? { overrides: { ...m.overrides } } : {}),
    ...(m.top_workers && m.top_workers.length > 0 ? { top_workers: [...m.top_workers] } : {}),
  });
  put('policy', typeof a.policy === 'object' && a.policy ? { repo: a.policy.repo, local: a.policy.local, pin: a.policy.pin } : a.policy);
  put('employer_rules', a.employer_rules);
  put('remote', { hq: a.remote.hq, ...(a.remote.hosted_on ? { hosted_on: a.remote.hosted_on } : {}) });
  put('policies_repo', a.policies_repo ? { path: a.policies_repo.path, remote: a.policies_repo.remote } : undefined);
  put('repos', Array.isArray(a.repos) ? a.repos.map((r) => ({ slug: r.slug, role: r.role, visibility: r.visibility, protected: r.protected, exists: r.exists })) : a.repos);
  put('issues_home', a.issues_home);
  put('roadmap', typeof a.roadmap === 'object' && a.roadmap ? { url: a.roadmap.url, status_field: a.roadmap.status_field } : a.roadmap);
  put('attribution', typeof a.attribution === 'object' ? { commit: a.attribution.commit, pr: a.attribution.pr } : a.attribution);
  put('enable_plugin', a.enable_plugin);
  return o;
}

function gates(g: GatesAnswer): unknown {
  if (g === 'accept') return 'accept';
  const out: Record<string, unknown> = {};
  if (g.stricter && Object.keys(g.stricter).length > 0) out.stricter = { ...g.stricter };
  if (g.looser && Object.keys(g.looser).length > 0) out.looser = { ...g.looser };
  return Object.keys(out).length > 0 ? out : 'accept';
}

function department(d: SetupDepartment): Record<string, unknown> {
  if (d.from === 'catalog') return { from: 'catalog', id: d.id };
  if (d.from === 'custom') {
    return {
      from: 'custom',
      id: d.id,
      role: d.role,
      purpose: d.purpose,
      scope: [...d.scope],
      triggers: [...d.triggers],
      exclusions: d.exclusions.map((x) => ({ item: x.item, owner: x.owner })),
      core_job: d.core_job,
    };
  }
  return {
    from: 'own',
    id: d.id,
    name: d.name,
    kind: d.kind,
    location: d.location,
    purpose: d.purpose,
    use_when: [...d.use_when],
    must_not: d.must_not.map((x) => ({ item: x.item, owner: x.owner })),
    replaces: d.replaces,
  };
}

/**
 * The answers file for `/ceo-of-agents:init-fleet <file>`. Keys follow the schema's example, a key with no value is left out,
 * a string a YAML 1.1 reader could take for a boolean, number or null is quoted, and multi-line text is a block literal.
 * It parses back to the same data (with `yaml`'s `parse`).
 */
export function toAnswersYaml(a: SetupAnswers): string {
  const doc = new Document(ordered(a));
  visit(doc, {
    Scalar(_key, node: Scalar) {
      if (typeof node.value !== 'string') return;
      const s = node.value;
      if (s.includes('\n') && !UNSAFE_FOR_BLOCK.test(s) && !s.includes('\r')) node.type = 'BLOCK_LITERAL';
      else if (needsQuotes(s) || UNSAFE_FOR_BLOCK.test(s) || s.includes('\r')) node.type = 'QUOTE_DOUBLE';
    },
  });
  // lineWidth 0: long answers are never folded.
  return doc.toString({ lineWidth: 0 });
}
