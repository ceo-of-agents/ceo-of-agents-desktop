// The facts the tips conditions and placeholders read, from the open org's hq files and the installed plugin's version.
// Read at display time, never stored, never written to the hq.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { orgIconStamp } from '../hq/org-icon';
import type { LoadedHq } from '../hq/read';
import { localDate, type HqFacts, type PendingFact } from './tips';

const MAX_FILE = 256 * 1024;
const BRIEF_RE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function readCapped(file: string): string {
  try {
    if (fs.statSync(file).size > MAX_FILE) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** `last_updated` in the frontmatter of company/state.md, as YYYY-MM-DD; null when missing or not a date. */
export function lastUpdatedOf(stateMd: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stateMd);
  if (!m) return null;
  try {
    const v = (parseYaml(m[1]) as { last_updated?: unknown } | null)?.last_updated;
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.trim() : '';
    return DATE_ONLY.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** The date in the name of the newest `YYYY-MM-DD-*.md` among the file names. */
export function newestBriefDate(names: string[]): string | null {
  const dates = names.map((n) => BRIEF_RE.exec(n)?.[1]).filter((d): d is string => !!d);
  return dates.length > 0 ? dates.sort().at(-1)! : null;
}

/** The `- Date:` line of the setup record. */
export function recordDate(md: string): string | null {
  const m = /^-\s+Date:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(md);
  return m ? m[1] : null;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function pendingFacts(hq: LoadedHq): PendingFact[] {
  const out: PendingFact[] = [];
  for (const w of hq.waiting) {
    if ('unparsed' in w) continue;
    // T items (company/todo.md) are the CEO's own list, not "Waiting on the CEO"; {wait} parents are group headings.
    if (w.kind === 'T') continue;
    if (w.action === 'ok' || w.action === 'do' || w.action === 'decide') out.push({ code: w.code, action: w.action, since: w.since });
  }
  return out;
}

export function gatherFacts(hqPath: string, hq: LoadedHq, pluginVersion: string | null, now: Date = new Date()): HqFacts {
  const setup = listDir(path.join(hqPath, 'decisions')).filter((n) => /^0001-.+\.md$/.test(n)).sort()[0];
  return {
    today: localDate(now),
    frameworkVersion: hq.org.frameworkVersion,
    pluginVersion,
    // The parser's default name stands for "no display_name": the schema's own fallback applies then.
    cosName: hq.org.cosName === 'Chief of Staff' ? '' : hq.org.cosName,
    chatLanguage: hq.org.chatLanguage,
    pending: pendingFacts(hq),
    lastUpdated: lastUpdatedOf(readCapped(path.join(hqPath, 'company', 'state.md'))),
    lastBriefDate: newestBriefDate(listDir(path.join(hqPath, 'company', 'briefs'))),
    hqSetupDate: setup ? recordDate(readCapped(path.join(hqPath, 'decisions', setup))) : null,
    exists: (rel) => {
      try {
        fs.lstatSync(path.join(hqPath, rel));
        return true;
      } catch {
        return false;
      }
    },
    hasOrgIcon: orgIconStamp(hqPath) !== null,
  };
}

/** `tips.show` and `tips.dismissed` of org.yaml (plugin schema, "Dismissals and the off switch in the CLI"); the app only reads them. */
export function readOrgTipsKey(orgYamlText: string): { show: boolean; dismissed: string[] } {
  try {
    const doc = parseYaml(orgYamlText) as { tips?: { show?: unknown; dismissed?: unknown } } | null;
    const tips = doc && typeof doc === 'object' ? doc.tips : undefined;
    if (!tips || typeof tips !== 'object') return { show: true, dismissed: [] };
    return {
      show: tips.show !== false,
      dismissed: Array.isArray(tips.dismissed) ? tips.dismissed.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return { show: true, dismissed: [] };
  }
}
