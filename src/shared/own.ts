// Ids and YAML keys (a department id such as `constructor` or `__proto__`) must never reach an inherited property.
// Use a `dict()` for an object indexed by such a key and `own()` to read one that may come from anywhere.

/** An empty object with no prototype: `d['__proto__']` and `d['constructor']` are ordinary keys, and `structuredClone` keeps them. */
export const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** `o[key]` only when it is the object's own property; undefined otherwise (never `constructor`, `toString`, ...). */
export function own<T>(o: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return o && Object.hasOwn(o, key) ? o[key] : undefined;
}

/** A `dict()` from `[id, value]` pairs (what `Object.fromEntries` would give, without the inherited keys). */
export function byId<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out = dict<T>();
  for (const [k, v] of entries) out[k] = v;
  return out;
}
