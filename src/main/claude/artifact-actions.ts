// What an `Artifact` tool call does, in plain words. Pure: no I/O.
// Input shape (Claude Code 2.1.328): `{ action, ...}`, for example `{ action: 'publish', file_path, title }` or
// `{ action: 'read', url: 'https://claude.ai/artifact/<id>' }`. Keys starting with `__artifact` are Claude Code's
// own bookkeeping: they are never read, shown or stored.
import path from 'node:path';
import { t } from '../../shared/strings';

/** Actions "Always allow" may cover: they only look, they never change or publish anything. */
export const SAFE_ARTIFACT_ACTIONS: readonly string[] = ['read', 'list', 'open'];

/** The rule Claude Code's matcher understands for one action: `key:value` against the input fields. */
export function artifactRuleFor(action: string): string {
  return `Artifact(action:${action})`;
}

const MAX_TITLE = 80;
const UUID_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BASE58_END = /(?:^|-)([1-9A-HJ-NP-Za-km-z]{22})$/;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,40}$/;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The artifact id of `https://claude.ai/artifact/<id>` or `.../code/artifact/<slug>-<id>`: the last path segment, without a slug prefix. */
function artifactId(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  let segment = '';
  try {
    segment = new URL(url.trim()).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return undefined;
  }
  const id = UUID_END.exec(segment)?.[1] ?? BASE58_END.exec(segment)?.[1] ?? segment.slice(segment.lastIndexOf('-') + 1);
  return PLAIN_ID.test(id) ? id : undefined;
}

/** The action of an Artifact call and what it is about: the title (or file name) for publish, the artifact id for an action on a URL. */
export function artifactAction(input: unknown): { action: string; target?: string } {
  const i = obj(input);
  const action = text(i.action);
  if (!action) return { action: '' };
  if (action === 'publish') {
    const title = text(i.title);
    const file = typeof i.file_path === 'string' ? path.basename(i.file_path.trim()) : '';
    const target = title || file;
    return target ? { action, target } : { action };
  }
  const id = artifactId(i.url);
  return id ? { action, target: id } : { action };
}

const WITH_ID = new Set(['delete', 'read', 'open', 'pin', 'unpin', 'share']);

/** One plain sentence for the permission card. Never the raw input. */
export function artifactSummary(input: unknown): string {
  const { action, target } = artifactAction(input);
  if (!action) return t('artifact.summary.unknown');
  if (action === 'publish') return target ? t('artifact.summary.publish', { title: cap(target, MAX_TITLE) }) : t('artifact.summary.publishNew');
  if (action === 'list') return t('artifact.summary.list');
  if (action === 'quickstart') return t('artifact.summary.quickstart');
  if (WITH_ID.has(action) && target) return t(`artifact.summary.${action}`, { id: target });
  return target ? t('artifact.summary.genericTarget', { action: cap(action, 40), target }) : t('artifact.summary.generic', { action: cap(action, 40) });
}

/** One short plain line for the thread's activity line. */
export function artifactActivity(input: unknown): string {
  const { action, target } = artifactAction(input);
  if (action === 'publish') return target ? t('activity.artifact.publish', { title: target }) : t('activity.artifact.publishNew');
  if (action === 'list') return t('activity.artifact.list');
  if (target && ['read', 'delete', 'open'].includes(action)) return t(`activity.artifact.${action}`, { id: target });
  return t('activity.artifact.other');
}
