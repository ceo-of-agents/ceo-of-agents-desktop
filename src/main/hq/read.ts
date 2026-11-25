import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Department, Initiative, WaitingEntry } from '../../shared/types';
import { parseDecisionCards } from './decisions';
import {
  buildDepartments,
  emptyOrg,
  orgYamlReadable,
  parseInitiativeStatus,
  parseOrgYaml,
  parseRoutingTable,
  parseTodo,
  parseWaiting,
  type ParsedOrg,
} from './parse';
import { readCapped } from './org-chart';

export interface LoadedHq {
  org: ParsedOrg;
  /** org.yaml is missing, empty or not valid: `org` and `departments` are then empty, not what the file said before. */
  orgReadable: boolean;
  departments: Department[];
  waiting: WaitingEntry[];
  initiatives: Initiative[];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function isHq(dir: string): boolean {
  return isFile(path.join(dir, 'org.yaml')) && isFile(path.join(dir, 'CLAUDE.md'));
}

export function loadInitiatives(hqPath: string): Initiative[] {
  const root = path.join(hqPath, 'initiatives');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const list: Initiative[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const file = path.join(dir, 'status.md');
    if (!isDir(dir) || !isFile(file)) continue;
    list.push(parseInitiativeStatus(name, readText(file)));
  }
  return list.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.slug.localeCompare(b.slug));
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** The text of a Markdown file without its leading `---` frontmatter block. */
export function stripFrontmatter(md: string): string {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return md;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end > 0 ? lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') : md;
}

/**
 * The body of `<hq>/initiatives/<slug>/status.md` (frontmatter removed), for the readable view in the side panel.
 * Null on any problem and never throws: a slug that is not a plain folder name, a missing file, a link anywhere on the
 * path (the hq's own folder may be one, nothing under it), a path that leaves `initiatives/`, or a file over 256 KB.
 */
export function readInitiativeStatus(hqPath: string, slug: string): string | null {
  try {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug === '.' || slug === '..') return null;
    const realHq = fs.realpathSync(hqPath);
    const root = path.join(realHq, 'initiatives');
    const dir = path.join(root, slug);
    const file = path.join(dir, 'status.md');
    if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(dir).isDirectory()) return null;
    if (!fs.lstatSync(file).isFile()) return null;
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    if (!realFile.startsWith(realRoot + path.sep)) return null;
    const text = readCapped(realFile);
    return text === null ? null : stripFrontmatter(text);
  } catch {
    return null;
  }
}

export function loadHq(hqPath: string): LoadedHq {
  const orgText = readText(path.join(hqPath, 'org.yaml'));
  const org = orgText ? parseOrgYaml(orgText) : emptyOrg();
  const roles = parseRoutingTable(readText(path.join(hqPath, 'CLAUDE.md')));
  const cards = parseDecisionCards(readText(path.join(hqPath, 'company', 'decision-queue.md')));
  const waiting = parseWaiting(readText(path.join(hqPath, 'company', 'state.md'))).map((w) => {
    if ('unparsed' in w) return w;
    const card = cards.get(w.code);
    if (!card) return w;
    return { ...w, card, ...(card.options.length >= 2 ? { options: card.options } : {}) };
  });
  // company/todo.md is optional (plugin schema todo/1): its open T items come after the A and D items.
  const todoPath = path.join(hqPath, 'company', 'todo.md');
  if (isFile(todoPath)) waiting.push(...parseTodo(readText(todoPath)));
  return {
    org,
    orgReadable: orgYamlReadable(orgText),
    departments: buildDepartments(org, roles),
    waiting,
    initiatives: loadInitiatives(hqPath),
  };
}

export function orgIdFor(hqPath: string): string {
  let real = hqPath;
  try {
    real = fs.realpathSync(hqPath);
  } catch {
    // folder gone: hash the given path
  }
  return crypto.createHash('sha1').update(real).digest('hex').slice(0, 12);
}
