// Model ids and aliases as a person reads them. Pure; no UI strings.

/** True for a specific model id ("claude-opus-5-5", also with a "[1m]" suffix or a provider prefix), false for an alias ("opus"). */
export function isSpecificModel(m: string | null | undefined): m is string {
  return !!m && /claude-/i.test(m);
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "[1m]" becomes " (1M)"; any other suffix is kept as it is. */
function suffixLabel(s: string | undefined): string {
  if (!s) return '';
  const inner = s.slice(1, -1);
  return ` (${/^\d+m$/i.test(inner) ? inner.toUpperCase() : inner})`;
}

/**
 * "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5",
 * "claude-opus-5-5[1m]" -> "Opus 5.5 (1M)". A shape it does not know comes back as the id itself.
 */
export function modelLabel(id: string): string {
  const m = id.trim();
  const dated = '(?:-\\d{8})?(\\[[^\\]]+\\])?$';
  const a = new RegExp(`^claude-([a-z]+)-(\\d{1,2})(?:-(\\d{1,2}))?${dated}`, 'i').exec(m);
  if (a && /^[a-z]+$/i.test(a[1])) return `${cap(a[1].toLowerCase())} ${a[3] ? `${a[2]}.${a[3]}` : a[2]}${suffixLabel(a[4])}`;
  const b = new RegExp(`^claude-(\\d{1,2})(?:-(\\d{1,2}))?-([a-z]+)${dated}`, 'i').exec(m);
  if (b) return `${cap(b[3].toLowerCase())} ${b[2] ? `${b[1]}.${b[2]}` : b[1]}${suffixLabel(b[4])}`;
  return id;
}

/** The tier a name belongs to ("opus", "opus[1m]", "claude-opus-5-5", "claude-3-5-sonnet" -> its tier), or null. */
export function tierOf(m: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | null {
  const hit = /(?:^|-)(opus|sonnet|haiku)(?:-|\[|$)/i.exec(m ?? '');
  return hit ? (hit[1].toLowerCase() as 'opus' | 'sonnet' | 'haiku') : null;
}
