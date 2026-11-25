import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../src/shared/strings/en.json';

const dir = 'src/renderer';
const files = [...readdirSync(dir), ...readdirSync(`${dir}/ui`).map((f) => `ui/${f}`)].filter((f) => f.endsWith('.tsx') || f === 'logic.ts');
const table = en as Record<string, string>;

describe('renderer strings', () => {
  it('every literal t() key exists in en.json', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) if (!(m[1] in table)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
  it('has keys for the dynamic lookups', () => {
    for (const k of ['health.label.green', 'health.label.yellow', 'health.label.orange', 'health.label.red', 'health.label.syncing']) expect(table[k]).toBeTruthy();
    for (const m of ['default', 'acceptEdits', 'auto', 'plan']) {
      expect(table[`settings.mode.${m}`]).toBeTruthy();
      expect(table[`settings.mode.${m}.hint`]).toBeTruthy();
    }
    for (const u of ['high', 'normal', 'low']) expect(table[`waiting.urgency.${u}`]).toBeTruthy();
  });
});

describe('tn (singular and plural strings)', () => {
  it('picks .one for 1 and .many otherwise, filling {count}', async () => {
    const { tn } = await import('../../src/shared/strings');
    expect(tn('health.ahead', 1)).toBe('1 change here not on GitHub yet');
    expect(tn('health.ahead', 0)).toBe('0 changes here not on GitHub yet');
    expect(tn('health.ahead', 5)).toBe('5 changes here not on GitHub yet');
    expect(tn('health.behind', 1)).toBe('1 change on GitHub not here yet');
    expect(tn('health.behind', 2)).toBe('2 changes on GitHub not here yet');
  });
  it('has both forms for every plural string', () => {
    for (const k of Object.keys(table).filter((x) => x.endsWith('.one'))) expect(table[k.replace(/\.one$/, '.many')]).toBeTruthy();
  });
});
