// Pattern matching shared by the connector modules (kept apart so they do not import each other).

/** A `*` matches any run of characters (also none); everything else matches itself. Iterative: no backtracking blow-up on many stars. */
export function matchesPattern(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = n;
    } else if (p < pattern.length && pattern[p] === name[n]) {
      p++;
      n++;
    } else if (star >= 0) {
      p = star + 1;
      n = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
