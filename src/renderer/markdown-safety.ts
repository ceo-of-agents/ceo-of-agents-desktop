// Safety rules for rendered Markdown. Pure, so they are tested without a browser.

import { t } from '../shared/strings';

/** The URL when it is a plain https link, else null. Nothing else (http, file, mailto, javascript, data, relative) is clickable. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const raw = href.trim();
  if (!/^https:\/\//i.test(raw) || [...raw].some((c) => c <= ' ' || c === '\u007f')) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** Text shown in place of an image: its alt text, else its address. Remote images are never loaded. */
export function imageText(alt: unknown, src: unknown): string {
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return typeof src === 'string' ? src : '';
}

/** Hover text for a clickable link: where it goes. Takes the already-checked https address. */
export function linkTitle(safe: string): string {
  return t('link.title', { host: new URL(safe).hostname, url: safe });
}

/** Longest input stripMarkdown looks at: keeps the regex work bounded on very long text. */
export const MAX_STRIP = 2000;

/** Plain text of a Markdown line, for tooltips and aria labels: markers removed, text kept. Whitespace collapsed to single spaces. */
export function stripMarkdown(text: string): string {
  return text
    .slice(0, MAX_STRIP)
    .replace(/^\s*```.*$/gm, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_m, alt: string, src: string) => alt.trim() || src)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
