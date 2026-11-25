// Contextual tips (plugin schema `tips/1`, schemas/tips.md of the ceo-of-agents plugin, v0.21.0+).
// Pure logic, no file access: parse the tips file, check each tip's condition against facts read from the open org's hq,
// fill the placeholders, pick the language and choose the one tip to show. Everything unknown hides the tip.
import { parse as parseYaml } from 'yaml';
import { compareVersions } from '../system/version';

export interface TipText {
  text: string;
  phrase: string;
}

export interface Tip extends TipText {
  id: string;
  /** Lowest framework version where the feature works; null for an app-side tip (no version gate). */
  since: string | null;
  /** The feature has not shipped yet: never shown. */
  pending: boolean;
  /** Condition mapping, kept as read: an unknown or malformed key makes the tip not applicable. */
  when: Record<string, unknown>;
  /** ISO 639-1 code -> text and phrase. */
  translations: Record<string, TipText>;
}

/** The tip as the renderer shows it: in the chat language, placeholders filled. */
export interface TipView extends TipText {
  id: string;
}

/** An open item of "Waiting on the CEO": its code, its kind tag and its since date. */
export interface PendingFact {
  code: string;
  action: 'ok' | 'do' | 'decide';
  since: string | null;
}

/** What the conditions and placeholders read, gathered from the open org's hq (see facts.ts). */
export interface HqFacts {
  /** Local date, YYYY-MM-DD. */
  today: string;
  frameworkVersion: string | null;
  /** Version of the installed plugin, null when unknown. */
  pluginVersion: string | null;
  /** `cos.display_name`, empty when not set. */
  cosName: string;
  /** `language.chat` of org.yaml. */
  chatLanguage: string;
  /** Open items of the pending list, children included, `{wait}` parents left out. */
  pending: PendingFact[];
  /** `last_updated` of company/state.md. */
  lastUpdated: string | null;
  /** Date of the newest company/briefs/YYYY-MM-DD-*.md. */
  lastBriefDate: string | null;
  /** Date of the setup record decisions/0001-*.md. */
  hqSetupDate: string | null;
  /** Whether a path relative to the hq root exists. */
  exists(rel: string): boolean;
  hasOrgIcon: boolean;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const LANG_RE = /^[a-z]{2}$/;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KINDS = new Set(['ok', 'do', 'decide']);
export const FALLBACK_COS_NAME = 'the chief of staff';

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function placeholderSet(s: string): Set<string> {
  return new Set([...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * The tips of a `tips/1` file. Never throws: a file that is not valid, or of another schema, gives no tips; a tip that is
 * not valid (no id, no text or phrase, no condition, a duplicate id) is skipped. A translation whose placeholders differ from
 * the source is dropped (English shows instead).
 */
export function parseTips(yamlText: string): Tip[] {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return [];
  }
  if (!isMapping(doc) || doc.schema !== 'tips/1' || !Array.isArray(doc.tips)) return [];
  const out: Tip[] = [];
  const seen = new Set<string>();
  for (const raw of doc.tips) {
    if (!isMapping(raw)) continue;
    const { id, text, phrase, when } = raw;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    if (!nonEmpty(text) || !nonEmpty(phrase) || !isMapping(when) || Object.keys(when).length === 0) continue;
    seen.add(id);
    const pending = raw.pending === true;
    const translations: Record<string, TipText> = {};
    if (isMapping(raw.translations)) {
      for (const [lang, entry] of Object.entries(raw.translations)) {
        if (!LANG_RE.test(lang) || !isMapping(entry) || !nonEmpty(entry.text) || !nonEmpty(entry.phrase)) continue;
        if (!sameSet(placeholderSet(entry.text), placeholderSet(text)) || !sameSet(placeholderSet(entry.phrase), placeholderSet(phrase))) continue;
        translations[lang] = { text: entry.text, phrase: entry.phrase };
      }
    }
    out.push({ id, since: typeof raw.since === 'string' && VERSION_RE.test(raw.since) ? raw.since : null, pending, when, text, phrase, translations });
  }
  return out;
}

// ---------- dates ----------

function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / 86400000);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? null : b - a;
}

/** The local date of a Date as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- conditions ----------

function minOf(v: unknown): number | null {
  return isMapping(v) && Object.keys(v).length === 1 && typeof v.min === 'number' && Number.isInteger(v.min) && v.min > 0 ? v.min : null;
}

function pendingKind(v: unknown): { kind: PendingFact['action']; min: number } | null {
  if (!isMapping(v) || Object.keys(v).length !== 2 || typeof v.kind !== 'string' || !KINDS.has(v.kind)) return null;
  if (typeof v.min !== 'number' || !Number.isInteger(v.min) || v.min <= 0) return null;
  return { kind: v.kind as PendingFact['action'], min: v.min };
}

/** A path inside the hq: relative, no `..`. */
function safeRelative(v: unknown): v is string {
  return nonEmpty(v) && !v.startsWith('/') && !v.split(/[\\/]/).includes('..');
}

/**
 * One condition key. Supported: `pending`, `days_since_last_session`, `days_since_last_brief`, `hq_behind_plugin`, `file_missing`
 * (plugin schema), and the app-side `always` and `org_icon_missing`. `chat` (a signal read from the conversation) and any other key
 * are not supported: the app has no model to judge them, so the tip does not apply.
 */
export function conditionHolds(key: string, value: unknown, f: HqFacts): boolean {
  switch (key) {
    case 'pending': {
      const c = pendingKind(value);
      return !!c && f.pending.filter((p) => p.action === c.kind).length >= c.min;
    }
    case 'days_since_last_session': {
      const min = minOf(value);
      const days = min === null || !f.lastUpdated ? null : daysBetween(f.lastUpdated, f.today);
      return min !== null && days !== null && days >= min;
    }
    case 'days_since_last_brief': {
      const min = minOf(value);
      if (min === null) return false;
      // With no brief yet, the hq's age (from the setup record) counts instead.
      const from = f.lastBriefDate ?? f.hqSetupDate;
      const days = from ? daysBetween(from, f.today) : null;
      return days !== null && days >= min;
    }
    case 'hq_behind_plugin':
      return value === true && !!f.frameworkVersion && !!f.pluginVersion && compareVersions(f.frameworkVersion, f.pluginVersion) < 0;
    case 'file_missing':
      return safeRelative(value) && !f.exists(value);
    case 'always':
      return value === true;
    case 'org_icon_missing':
      return value === true && !f.hasOrgIcon;
    default:
      return false;
  }
}

/** All keys of `when` must hold. An empty or missing mapping never holds. */
export function whenHolds(when: Record<string, unknown>, f: HqFacts): boolean {
  const keys = Object.keys(when);
  return keys.length > 0 && keys.every((k) => conditionHolds(k, when[k], f));
}

// ---------- placeholders ----------

/** The open items that match the tip's `pending` condition, oldest `since` first (no date last), at most 3. */
function matchingCodes(tip: Tip, f: HqFacts): string[] {
  const c = pendingKind(tip.when.pending);
  if (!c) return [];
  const items = f.pending.map((p, i) => ({ p, i })).filter(({ p }) => p.action === c.kind);
  items.sort((a, b) => {
    if (a.p.since && b.p.since && a.p.since !== b.p.since) return a.p.since < b.p.since ? -1 : 1;
    if (!!a.p.since !== !!b.p.since) return a.p.since ? -1 : 1;
    return a.i - b.i;
  });
  return items.slice(0, 3).map(({ p }) => p.code);
}

/**
 * Supported: `{codes}`, `{decision_code}` (the oldest open `{decide}` item: its code), `{cos_name}`. Not supported, so the tip is
 * hidden: `{department}`, `{initiative}` and `{repo}` (the schema leaves what "fits", "idle" and "named in the chat" mean open,
 * or needs the conversation) and any unknown name.
 */
function placeholderValue(name: string, tip: Tip, f: HqFacts): string | null {
  switch (name) {
    case 'codes': {
      const codes = matchingCodes(tip, f);
      return codes.length > 0 ? codes.join(', ') : null;
    }
    case 'decision_code': {
      const decide = f.pending.map((p, i) => ({ p, i })).filter(({ p }) => p.action === 'decide');
      decide.sort((a, b) => (a.p.since && b.p.since && a.p.since !== b.p.since ? (a.p.since < b.p.since ? -1 : 1) : a.i - b.i));
      return decide[0]?.p.code ?? null;
    }
    case 'cos_name':
      return f.cosName.trim() || FALLBACK_COS_NAME;
    default:
      return null;
  }
}

/** The text with every placeholder filled, or null when one cannot be (no blanks, no generic fallback). */
export function fillTemplate(template: string, tip: Tip, f: HqFacts): string | null {
  let ok = true;
  const out = template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = placeholderValue(name, tip, f);
    if (v === null) ok = false;
    return v ?? '';
  });
  return ok ? out : null;
}

// ---------- language ----------

/** The ISO 639-1 code of `language.chat` ("it", "it-IT", "pt_BR" all work), or null when it is not a code (for example a language name). */
export function languageCode(chatLanguage: string): string | null {
  const m = /^([A-Za-z]{2})(?:[-_][A-Za-z0-9]+)?$/.exec(chatLanguage.trim());
  return m ? m[1].toLowerCase() : null;
}

/** The translation for the chat language when the tip has one, else the English source. */
export function textInLanguage(tip: Tip, chatLanguage: string): TipText {
  const code = languageCode(chatLanguage);
  return (code && code !== 'en' && tip.translations[code]) || { text: tip.text, phrase: tip.phrase };
}

// ---------- selection ----------

/** Whether the tip may be shown at all: not pending, `since` met by the hq's framework version, condition true. */
export function tipApplies(tip: Tip, f: HqFacts): boolean {
  if (tip.pending) return false;
  if (tip.since !== null && !(f.frameworkVersion && compareVersions(f.frameworkVersion, tip.since) >= 0)) return false;
  return whenHolds(tip.when, f);
}

/** The tip filled and translated, or null when a placeholder cannot be filled. */
export function renderTip(tip: Tip, f: HqFacts): TipView | null {
  const src = textInLanguage(tip, f.chatLanguage);
  const text = fillTemplate(src.text, tip, f);
  const phrase = fillTemplate(src.phrase, tip, f);
  return text === null || phrase === null ? null : { id: tip.id, text, phrase };
}

/**
 * The one tip to show: among the tips that are not dismissed, apply and can be filled (file order), the one at the position
 * (day of the month mod number of candidates), like the CLI, so tips rotate without stored state. Null when there is none.
 */
export function selectTip(tips: Tip[], f: HqFacts, dismissed: ReadonlySet<string>): TipView | null {
  return selectTips(tips, f, dismissed)[0] ?? null;
}

/**
 * Every tip that is not dismissed, applies and can be filled, in file order but starting at the one `selectTip` picks (day of the
 * month mod number of candidates) and wrapping, so the first one is the tip shown now and the rest follow it. Empty when none.
 */
export function selectTips(tips: Tip[], f: HqFacts, dismissed: ReadonlySet<string>): TipView[] {
  const candidates: TipView[] = [];
  for (const tip of tips) {
    if (dismissed.has(tip.id) || !tipApplies(tip, f)) continue;
    const view = renderTip(tip, f);
    if (view) candidates.push(view);
  }
  if (candidates.length === 0) return [];
  const day = Number(DATE_RE.exec(f.today)?.[3] ?? 0);
  const start = day % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}
