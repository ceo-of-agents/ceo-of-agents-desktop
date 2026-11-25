import { describe, expect, it } from 'vitest';
import { columnsFor, layoutChart, rowSizes, NODE_H, NODE_W } from '../../src/renderer/org-chart-layout';

describe('columnsFor: k = floor((W + 16) / 216)', () => {
  it('the spec widths: 858 gives 4, 1159 gives 5', () => {
    expect(columnsFor(858)).toBe(4);
    expect(columnsFor(1159)).toBe(5);
  });
  it('the edges of each step, and never below 1', () => {
    expect(columnsFor(632)).toBe(3);
    expect(columnsFor(631)).toBe(2);
    expect(columnsFor(416)).toBe(2);
    expect(columnsFor(415)).toBe(1);
    expect(columnsFor(200)).toBe(1);
    expect(columnsFor(0)).toBe(1);
  });
});

describe('rowSizes: balanced rows', () => {
  it('7 departments with k = 4 make rows of 4 and 3; 8 with k = 5 make 4 and 4', () => {
    expect(rowSizes(7, 4)).toEqual([4, 3]);
    expect(rowSizes(8, 5)).toEqual([4, 4]);
  });
  it('up to k is one row; none is no row', () => {
    expect(rowSizes(4, 4)).toEqual([4]);
    expect(rowSizes(1, 4)).toEqual([1]);
    expect(rowSizes(0, 4)).toEqual([]);
  });
  it('more rows, still balanced and complete', () => {
    expect(rowSizes(9, 4)).toEqual([3, 3, 3]);
    expect(rowSizes(5, 4)).toEqual([3, 2]);
    expect(rowSizes(10, 4)).toEqual([4, 4, 2]);
    expect(rowSizes(3, 1)).toEqual([1, 1, 1]);
    for (let n = 1; n < 40; n++) for (let k = 1; k < 8; k++) expect(rowSizes(n, k).reduce((a, b) => a + b, 0)).toBe(n);
  });
});

describe('layoutChart: tree mode (n <= k)', () => {
  const l = layoutChart({ width: 858, departments: 2 });
  it('is a tree with one row, centred', () => {
    expect(l.mode).toBe('tree');
    expect(l.k).toBe(4);
    expect(l.rows).toEqual([2]);
    expect(l.spineX).toBe(429);
    expect(l.ceo).toEqual({ x: 329, y: 0 });
    expect(l.cos).toEqual({ x: 329, y: 96 });
  });
  it('two nodes are 416 px wide with a 16 px gap, centred; their top is 16 px under the bus, 20 px under the CoS', () => {
    expect(l.cells.map((c) => [c.x, c.y])).toEqual([[221, 204], [437, 204]]);
    expect(l.cells[1].x - l.cells[0].x - NODE_W).toBe(16);
    expect(l.cells[0].y).toBe(96 + NODE_H + 20 + 16);
    expect(l.height).toBe(204 + NODE_H);
  });
  it('the bus runs from the first centre to the last, with rounded corners of 8 px', () => {
    const bus = l.edges.find((e) => e.id === 'bus-0');
    expect(bus?.d).toBe('M329 188L529 188');
    expect(l.edges.find((e) => e.id === 'drop-0')?.d).toBe('M329 188Q321 188 321 196L321 204');
    expect(l.edges.find((e) => e.id === 'drop-1')?.d).toBe('M529 188Q537 188 537 196L537 204');
    expect(l.edges.find((e) => e.id === 'stem')?.d).toBe('M429 168L429 188');
  });
  it('one department centred under the CoS is a straight line', () => {
    const one = layoutChart({ width: 858, departments: 1 });
    expect(one.edges.find((e) => e.id === 'stem')?.d).toBe('M429 168L429 204');
    expect(one.edges.some((e) => e.id.startsWith('bus'))).toBe(false);
    expect(one.cells[0].x).toBe(329);
  });
  it('4 departments at 858 and 5 at 1159 are still a tree; 5 at 858 is a grid', () => {
    expect(layoutChart({ width: 858, departments: 4 }).mode).toBe('tree');
    expect(layoutChart({ width: 1159, departments: 5 }).mode).toBe('tree');
    expect(layoutChart({ width: 858, departments: 5 }).mode).toBe('grid');
  });
});

describe('layoutChart: grid mode (n > k)', () => {
  const l = layoutChart({ width: 858, departments: 7 });
  it('7 departments at k = 4 are rows of 4 and 3, columns lined up, the grid centred', () => {
    expect(l.mode).toBe('grid');
    expect(l.rows).toEqual([4, 3]);
    const xs = l.cells.map((c) => c.x);
    // grid is 4 * 200 + 3 * 16 = 848 wide in 858: left edge 5
    expect(xs.slice(0, 4)).toEqual([5, 221, 437, 653]);
    expect(xs.slice(4)).toEqual([5, 221, 437]);
    expect(l.cells.slice(0, 4).every((c) => c.y === 204)).toBe(true);
    expect(l.cells.slice(4).every((c) => c.y === 204 + NODE_H + 16 + 16)).toBe(true);
  });
  it('8 departments at k = 5 (1159 wide, panel closed) are 4 and 4', () => {
    const g = layoutChart({ width: 1159, departments: 8 });
    expect(g.rows).toEqual([4, 4]);
    expect(g.mode).toBe('grid');
    expect(g.cells[0].x).toBe((1159 - 848) / 2);
  });
  it('the trunk is 12 px left of the first column and runs from the first bus to the last', () => {
    const trunk = l.edges.find((e) => e.id === 'trunk')?.d;
    expect(trunk).toBe('M1 188Q-7 188 -7 196L-7 284Q-7 292 1 292');
  });
  it('the CoS stem meets the first bus at the canvas centre; each bus ends at the last node of its row', () => {
    expect(l.edges.find((e) => e.id === 'stem')?.d).toBe('M429 168L429 188');
    expect(l.edges.find((e) => e.id === 'bus-0')?.d).toBe('M1 188L745 188');
    expect(l.edges.find((e) => e.id === 'bus-1')?.d).toBe('M1 292L529 292');
  });
  it('chip blocks add 8 px and their height to the row, and 16 px to the next bus', () => {
    const g = layoutChart({ width: 858, departments: 7, chipHeights: [18, 18, 0, 0, 18, 0, 0] });
    expect(g.cells[4].y).toBe(204 + NODE_H + 8 + 18 + 16 + 16);
    expect(g.height).toBe(g.cells[4].y + NODE_H + 8 + 18);
    expect(g.edges.filter((e) => e.id.startsWith('stub')).length).toBe(3);
  });
  it('k = 1 is a plain list hanging from the trunk', () => {
    const list = layoutChart({ width: 200, departments: 3 });
    expect(list.k).toBe(1);
    expect(list.mode).toBe('grid');
    expect(list.rows).toEqual([1, 1, 1]);
    expect(new Set(list.cells.map((c) => c.x)).size).toBe(1);
    expect(list.cells.map((c) => c.y)).toEqual([204, 204 + 104, 204 + 208]);
    expect(list.edges.some((e) => e.id === 'trunk')).toBe(true);
  });
});

describe('layoutChart: the spine, the chips and the empty state', () => {
  it('the CoS chips sit 24 px right of the CoS node, joined by a dashed line', () => {
    const l = layoutChart({ width: 858, departments: 2, cosChipsWidth: 150 });
    expect(l.cosChips).toEqual({ x: 429 + 100 + 24, y: 96 + 36 - 9, maxWidth: 858 - 553 });
    expect(l.edges.find((e) => e.id === 'cos-helpers')).toMatchObject({ dashed: true, d: 'M529 132L553 132' });
  });
  it('the spine shifts left until the chips fit', () => {
    const l = layoutChart({ width: 600, departments: 1, cosChipsWidth: 300 });
    expect(l.spineX).toBe(600 - 100 - 24 - 300);
    expect(l.cos.x).toBe(l.spineX - 100);
    expect(l.cosChips!.x + 300).toBeLessThanOrEqual(600);
  });
  it('the spine never leaves the canvas on the left', () => {
    expect(layoutChart({ width: 300, departments: 0, cosChipsWidth: 900 }).spineX).toBe(100);
  });
  it('no departments: a dashed 20 px stem to a placeholder node', () => {
    const l = layoutChart({ width: 858, departments: 0 });
    expect(l.cells).toEqual([]);
    expect(l.empty).toEqual({ x: 329, y: 188 });
    expect(l.edges.find((e) => e.id === 'stem')).toMatchObject({ dashed: true, d: 'M429 168L429 188' });
    expect(l.height).toBe(188 + NODE_H);
    expect(layoutChart({ width: 858, departments: 0, emptyHeight: 104 }).height).toBe(188 + 104);
  });
  it('the add cell counts as one more department, with a dashed drop', () => {
    const l = layoutChart({ width: 858, departments: 4, addCell: true });
    expect(l.mode).toBe('grid');
    expect(l.cells).toHaveLength(5);
    expect(l.cells[4].add).toBe(true);
    expect(l.edges.find((e) => e.id === 'drop-4')?.dashed).toBe(true);
    expect(layoutChart({ width: 858, departments: 3, addCell: true }).mode).toBe('tree');
  });
  it('a chip row hangs from a stub 12 px right of the node, starts 6 px after it and stays in the 200 px column, last column included', () => {
    for (const width of [858, 1159]) {
      const l = layoutChart({ width, departments: 8, chipHeights: Array(8).fill(18) });
      for (const c of l.cells) {
        expect(c.chipX).toBe(c.x + 12 + 6);
        expect(c.chipMaxWidth).toBe(182);
        expect(c.chipX + c.chipMaxWidth).toBe(c.x + NODE_W);
        const stub = l.edges.find((e) => e.id === `stub-${c.index}`);
        expect(stub?.d).toBe(`M${c.x + 12} ${c.y + 72}L${c.x + 12} ${c.y + 72 + 17}`);
        expect(stub?.dashed).toBe(true);
      }
    }
  });
  it('the legend lines up with the chart: the first node in tree mode, the trunk in grid mode', () => {
    const tree = layoutChart({ width: 858, departments: 2 });
    expect(tree.legendX).toBe(tree.cells[0].x);
    expect(tree.legendX).toBe(858 / 2 - 208);
    const grid = layoutChart({ width: 858, departments: 8 });
    expect(grid.mode).toBe('grid');
    expect(grid.legendX).toBe(grid.cells[0].x - 12);
    const one = layoutChart({ width: 858, departments: 1 });
    expect(one.legendX).toBe(one.ceo.x);
    expect(layoutChart({ width: 858, departments: 0 }).legendX).toBe(429 - 100);
  });
  it('never wider than the canvas and never scrolls sideways: every node lies inside it at k nodes per row', () => {
    for (const width of [858, 1159, 632, 416, 300]) {
      for (let n = 0; n < 14; n++) {
        const l = layoutChart({ width, departments: n });
        for (const c of l.cells) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x + NODE_W).toBeLessThanOrEqual(Math.max(width, NODE_W));
        }
      }
    }
  });
});
