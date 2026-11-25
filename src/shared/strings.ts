// All user-facing text lives in one file per language (src/shared/strings/<lang>.json). English only for now.
import en from './strings/en.json';

export type StringKey = keyof typeof en;
const table: Record<string, string> = en;

/** Looks up a string and fills {placeholders}. Unknown keys return the key, so a missing string is visible. */
export function t(key: StringKey | string, vars: Record<string, string | number> = {}): string {
  const s = table[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A string with a singular and a plural form: `<base>.one` when `count` is 1, else `<base>.many`. `{count}` is filled in. */
export function tn(base: string, count: number, vars: Record<string, string | number> = {}): string {
  return t(`${base}.${count === 1 ? 'one' : 'many'}`, { ...vars, count });
}
