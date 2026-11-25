/** First x.y.z found in a string, or null. */
export function parseVersion(s: string | null | undefined): string | null {
  const m = /\d+\.\d+\.\d+/.exec(s ?? '');
  return m ? m[0] : null;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** min <= v < maxExclusive. */
export function inRange(v: string, min: string, maxExclusive: string): boolean {
  return compareVersions(v, min) >= 0 && compareVersions(v, maxExclusive) < 0;
}

export function rangeLabel(min: string, maxExclusive: string): string {
  return `>=${min} <${maxExclusive}`;
}
