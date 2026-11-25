import { describe, expect, it } from 'vitest';
import type { OrgChartWorker } from '../../src/shared/types';
import { CHIP_GAP, CHIP_ROW_MAX, NODE_TEXT_W, ROLE_MODEL_GAP, chipWidth, fitChips, fitRoleModel, modelWidth } from '../../src/renderer/org-chart-chips';

const w = (name: string, model = 'sonnet'): OrgChartWorker => ({ name, model, description: '' });
const names = (ws: OrgChartWorker[]) => ws.map((x) => x.name);

describe('fitChips (estimated widths; one line inside the node column)', () => {
  it('the row may use the 200 px column minus the stub offset (12) and the gap to the first chip (6)', () => {
    expect(CHIP_ROW_MAX).toBe(182);
    expect(CHIP_GAP).toBe(6);
  });

  it('the review case: READER WORKER Sonnet is about 167 px and fits whole', () => {
    const f = fitChips([w('reader'), w('worker')], 'Sonnet');
    expect(f.width).toBeGreaterThanOrEqual(160);
    expect(f.width).toBeLessThanOrEqual(CHIP_ROW_MAX);
    expect(names(f.shown)).toEqual(['reader', 'worker']);
    expect(f.folded).toEqual([]);
    expect(f.showModel).toBe(true);
  });

  it('a row with no model text just has chips', () => {
    const f = fitChips([w('reader')], '');
    expect(f).toMatchObject({ showModel: false, folded: [] });
    expect(f.width).toBe(chipWidth('reader'));
  });

  it('the model text goes first when the row is too wide', () => {
    const ws = [w('reader'), w('scout'), w('worker')]; // three chips fit (about 160 px), the model does not
    const f = fitChips(ws, 'Sonnet');
    expect(f.showModel).toBe(false);
    expect(f.shown).toEqual(ws);
    expect(f.folded).toEqual([]);
    expect(f.width).toBeLessThanOrEqual(CHIP_ROW_MAX);
  });

  it('then the extra chips fold into one "+n" chip that names them', () => {
    const ws = [w('reader'), w('scout'), w('worker'), w('archivist'), w('critic')];
    const f = fitChips(ws, 'Sonnet, Haiku');
    expect(f.showModel).toBe(false);
    expect(f.folded.length).toBeGreaterThan(0);
    expect([...names(f.shown), ...names(f.folded)]).toEqual(names(ws));
    expect(f.width).toBeLessThanOrEqual(CHIP_ROW_MAX);
    // the most chips that fit: one more would not
    const more = [...ws.slice(0, f.shown.length + 1).map((x) => chipWidth(x.name)), chipWidth(`+${f.folded.length - 1}`)];
    expect(more.reduce((a, x) => a + x, 0) + (more.length - 1) * CHIP_GAP).toBeGreaterThan(CHIP_ROW_MAX);
  });

  it('never wider than the column, whatever the names', () => {
    for (let n = 0; n <= 9; n++) {
      for (const len of [1, 5, 12, 40]) {
        const ws = Array.from({ length: n }, (_, i) => w(`${'x'.repeat(len)}${i}`));
        const f = fitChips(ws, 'Sonnet, Haiku, Opus');
        if (f.shown.length > 0 || f.folded.length > 1) expect(f.width).toBeLessThanOrEqual(CHIP_ROW_MAX);
        expect(f.shown.length + f.folded.length).toBe(n);
      }
    }
  });

  it('when not even one chip and "+n" fit, only the "+n" chip is left', () => {
    const f = fitChips([w('a-very-long-helper-name-indeed'), w('another-long-helper-name-here')], 'Sonnet');
    expect(f.shown).toEqual([]);
    expect(names(f.folded)).toEqual(['a-very-long-helper-name-indeed', 'another-long-helper-name-here']);
    expect(f.width).toBe(chipWidth('+2'));
  });

  it('estimates by characters: wider text, wider box', () => {
    expect(chipWidth('worker')).toBeGreaterThan(chipWidth('reader') - 1);
    expect(chipWidth('researcher')).toBeGreaterThan(chipWidth('reader'));
    expect(modelWidth('Sonnet, Haiku')).toBeGreaterThan(modelWidth('Sonnet'));
  });
});

describe('fitRoleModel (line 2 of a node: the role wins over the model)', () => {
  it('the text column is the node minus borders, padding, avatar and gap, and the gap is 8 px', () => {
    expect(NODE_TEXT_W).toBe(136);
    expect(ROLE_MODEL_GAP).toBe(8);
  });

  it('shows the model when both fit with the gap', () => {
    expect(fitRoleModel('Engineering', 'Opus')).toBe(true);
    expect(fitRoleModel('Chief of staff', 'Opus')).toBe(true);
  });

  it('drops the model when the role and the model do not both fit', () => {
    expect(fitRoleModel('Design and brand', 'Opus')).toBe(false);
    expect(fitRoleModel('Engineering', 'Opus', 100)).toBe(false);
  });

  it('drops the model when the role alone is too long (the role takes the ellipsis)', () => {
    expect(fitRoleModel('A role name that is far too long for the column', 'Opus')).toBe(false);
  });

  it('with no role the model has the line to itself; with no model nothing shows', () => {
    expect(fitRoleModel('', 'Opus')).toBe(true);
    expect(fitRoleModel('Engineering', '')).toBe(false);
    expect(fitRoleModel('', '')).toBe(false);
  });

  it('a shown model always leaves the gap: role + gap + model never passes the column', () => {
    for (let len = 0; len <= 30; len++) {
      const role = 'x'.repeat(len);
      if (len > 0 && fitRoleModel(role, 'Sonnet')) expect(modelWidth(role) + ROLE_MODEL_GAP + modelWidth('Sonnet')).toBeLessThanOrEqual(NODE_TEXT_W);
    }
  });
});
