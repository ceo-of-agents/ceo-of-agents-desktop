// The org chart's layout (spec section 2), as one pure function: where every node, chip row and edge goes for a
// canvas width. The component only renders what this returns (nodes by transform, edges as SVG paths), so the maths
// is tested without a DOM. All numbers are px, relative to the top-left of the chart.

export const NODE_W = 200;
export const NODE_H = 72;
export const GAP = 16;
/** CEO node to CoS node. */
export const SPINE_STEM = 24;
/** CoS node to the first bus. */
export const BUS_STEM = 20;
/** Bus to the top of a node. */
export const DROP = 16;
/** Node to its chip row. */
export const CHIPS_TOP = 8;
/** Under a chip row, to the next bus. */
export const ROW_GAP = 16;
/** The dashed stub of a department's chip row, from the node's left edge. */
export const STUB_LEFT = 12;
/** Chip row start, right of the stub. */
export const CHIPS_LEFT = 6;
/** CoS node to its chips. */
export const COS_CHIPS_GAP = 24;
/** Trunk, left of the first grid column. */
export const TRUNK_OFFSET = 12;
export const CORNER = 8;
export const CHIP_H = 18;
/** A stub runs from the node down to the middle of the first chip line. */
const STUB = CHIPS_TOP + CHIP_H / 2;

/** Department nodes per row: floor((W + 16) / 216), at least 1. */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (NODE_W + GAP)));
}

/** Row lengths: one row up to k; above k, ceil(n / k) rows of ceil(n / rows) each, filled left to right (7 with k 4: 4 and 3). */
export function rowSizes(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (n <= k) return [n];
  const rows = Math.ceil(n / k);
  const per = Math.ceil(n / rows);
  const out: number[] = [];
  for (let left = n; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

export interface LayoutInput {
  /** The canvas width minus its padding. */
  width: number;
  /** Department nodes. */
  departments: number;
  /** "+ Add department" counts as one more cell (the flag is off for now). */
  addCell?: boolean;
  /** Height of each department's chip block (measured; 0 or missing: no chips). */
  chipHeights?: number[];
  /** Natural width of the CoS chip block (measured; 0: none). */
  cosChipsWidth?: number;
  /** Height of the "No departments yet" placeholder (measured; its text is longer than 72 px allows). */
  emptyHeight?: number;
}

export interface Edge {
  id: string;
  /** SVG path data. */
  d: string;
  /** 1 px dashed (worker links, placeholder stem) instead of the 2 px line. */
  dashed?: boolean;
}

export interface Cell {
  index: number;
  row: number;
  col: number;
  /** Top-left of the node. */
  x: number;
  y: number;
  /** Where the chip block starts and the widest it may be (the rest of the node's column: the row never wraps). */
  chipX: number;
  chipY: number;
  chipMaxWidth: number;
  /** The "+ Add department" cell. */
  add: boolean;
}

export interface ChartLayout {
  mode: 'tree' | 'grid';
  /** Nodes per row at this width. */
  k: number;
  rows: number[];
  width: number;
  height: number;
  /** The centre line of the CEO and the CoS (the canvas centre unless the CoS chips need room). */
  spineX: number;
  ceo: { x: number; y: number };
  cos: { x: number; y: number };
  /** Where the CoS chip block starts and the widest it may be. */
  cosChips: { x: number; y: number; maxWidth: number } | null;
  cells: Cell[];
  /** Placeholder when there are no departments and no add cell. */
  empty: { x: number; y: number } | null;
  edges: Edge[];
  /** Where the legend's left edge goes: the chart's leftmost element (the first node in tree mode, the trunk in grid mode). */
  legendX: number;
}

const f = (n: number): string => String(Math.round(n * 100) / 100);
const line = (x1: number, y1: number, x2: number, y2: number): string => `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;

export function layoutChart(input: LayoutInput): ChartLayout {
  const W = Math.max(NODE_W, input.width);
  const n = input.departments + (input.addCell ? 1 : 0);
  const chipH = (i: number): number => input.chipHeights?.[i] ?? 0;
  const k = columnsFor(W);
  const rows = rowSizes(n, k);
  const mode: 'tree' | 'grid' = n <= k ? 'tree' : 'grid';

  // Spine: centred, shifted left until the CoS chips fit to its right.
  const chipsW = input.cosChipsWidth ?? 0;
  let spineX = W / 2;
  if (chipsW > 0) spineX = Math.max(NODE_W / 2, Math.min(spineX, W - NODE_W / 2 - COS_CHIPS_GAP - chipsW));
  const ceoY = 0;
  const cosY = NODE_H + SPINE_STEM;
  const cosBottom = cosY + NODE_H;
  const busY0 = cosBottom + BUS_STEM;
  const ceo = { x: spineX - NODE_W / 2, y: ceoY };
  const cos = { x: spineX - NODE_W / 2, y: cosY };

  const edges: Edge[] = [{ id: 'spine', d: line(spineX, ceoY + NODE_H, spineX, cosY) }];
  const chipsX = spineX + NODE_W / 2 + COS_CHIPS_GAP;
  const cosChips = chipsW > 0 ? { x: chipsX, y: cosY + NODE_H / 2 - CHIP_H / 2, maxWidth: Math.max(0, W - chipsX) } : null;
  if (cosChips) edges.push({ id: 'cos-helpers', d: line(spineX + NODE_W / 2, cosY + NODE_H / 2, chipsX, cosY + NODE_H / 2), dashed: true });

  if (n === 0) {
    edges.push({ id: 'stem', d: line(spineX, cosBottom, spineX, busY0), dashed: true });
    return { mode, k, rows, width: W, height: busY0 + Math.max(NODE_H, input.emptyHeight ?? NODE_H), spineX, ceo, cos, cosChips, cells: [], empty: { x: spineX - NODE_W / 2, y: busY0 }, edges, legendX: ceo.x };
  }

  // Columns: tree mode centres the one row; grid mode centres the widest row's columns.
  const perRow = Math.max(...rows);
  const left = (W - (perRow * NODE_W + (perRow - 1) * GAP)) / 2;
  const rowLeft = (r: number): number => (mode === 'tree' ? (W - (rows[r] * NODE_W + (rows[r] - 1) * GAP)) / 2 : left);

  // Row tops and bus heights: node, chip block (8 + its height), 16 to the next bus, 16 drop.
  const busY: number[] = [];
  const tops: number[] = [];
  const chipBlock: number[] = [];
  const rowCells: Cell[][] = [];
  let index = 0;
  rows.forEach((count, r) => {
    const row: Cell[] = [];
    let block = 0;
    for (let c = 0; c < count; c++, index++) {
      if (chipH(index) > 0) block = Math.max(block, CHIPS_TOP + chipH(index));
      row.push({ index, row: r, col: c, x: rowLeft(r) + c * (NODE_W + GAP), y: 0, chipX: 0, chipY: 0, chipMaxWidth: 0, add: !!input.addCell && index === n - 1 });
    }
    busY[r] = r === 0 ? busY0 : tops[r - 1] + NODE_H + chipBlock[r - 1] + ROW_GAP;
    tops[r] = busY[r] + DROP;
    chipBlock[r] = block;
    rowCells.push(row);
  });
  const cells = rowCells.flat();
  const centreOf = (cell: Cell): number => cell.x + NODE_W / 2;
  for (const cell of cells) {
    cell.y = tops[cell.row];
    // The stub hangs 12 px from the node's left; the chips start 6 px right of it and stay inside the node's column.
    const stubX = cell.x + STUB_LEFT;
    cell.chipX = stubX + CHIPS_LEFT;
    cell.chipY = cell.y + NODE_H + CHIPS_TOP;
    cell.chipMaxWidth = NODE_W - STUB_LEFT - CHIPS_LEFT;
    if (chipH(cell.index) > 0 && !cell.add) edges.push({ id: `stub-${cell.index}`, d: line(stubX, cell.y + NODE_H, stubX, cell.y + NODE_H + STUB), dashed: true });
  }

  // Edges. The stem comes down the spine to the first bus; a bus ends in a rounded corner on its last drop.
  const r = CORNER;
  const drop = (cell: Cell, y: number, corner: 'none' | 'from-left' | 'from-right'): Edge => {
    const x = centreOf(cell);
    const to = `L${f(x)} ${f(cell.y)}`;
    const d =
      corner === 'from-left' ? `M${f(x - r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + r)}${to}`
      : corner === 'from-right' ? `M${f(x + r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + r)}${to}`
      : `M${f(x)} ${f(y)}${to}`;
    return { id: `drop-${cell.index}`, d, dashed: cell.add || undefined };
  };

  if (mode === 'tree') {
    const row = rowCells[0];
    const first = centreOf(row[0]);
    const last = centreOf(row[row.length - 1]);
    const lo = Math.min(first, spineX);
    const hi = Math.max(last, spineX);
    if (row.length === 1 && first === spineX) {
      edges.push({ id: 'stem', d: line(spineX, cosBottom, spineX, row[0].y) });
    } else {
      edges.push({ id: 'stem', d: line(spineX, cosBottom, spineX, busY0) });
      const cornerLo = first === lo && row.length > 1;
      const cornerHi = last === hi;
      edges.push({ id: 'bus-0', d: line(cornerLo ? lo + r : lo, busY0, cornerHi ? hi - r : hi, busY0) });
      row.forEach((cell, i) => edges.push(drop(cell, busY0, cornerLo && i === 0 ? 'from-right' : cornerHi && i === row.length - 1 ? 'from-left' : 'none')));
    }
  } else {
    const tx = left - TRUNK_OFFSET;
    const lastRow = rows.length - 1;
    edges.push({ id: 'stem', d: line(spineX, cosBottom, spineX, busY0) });
    // The trunk has a rounded corner at the first bus and at the last one.
    edges.push({ id: 'trunk', d: `M${f(tx + r)} ${f(busY[0])}Q${f(tx)} ${f(busY[0])} ${f(tx)} ${f(busY[0] + r)}L${f(tx)} ${f(busY[lastRow] - r)}Q${f(tx)} ${f(busY[lastRow])} ${f(tx + r)} ${f(busY[lastRow])}` });
    rowCells.forEach((row, j) => {
      const end = centreOf(row[row.length - 1]) - r;
      edges.push({ id: `bus-${j}`, d: line(j === 0 || j === lastRow ? tx + r : tx, busY[j], j === 0 ? Math.max(end, spineX) : end, busY[j]) });
      row.forEach((cell, i) => edges.push(drop(cell, busY[j], i === row.length - 1 ? 'from-left' : 'none')));
    });
  }

  const lastRow = rows.length - 1;
  // Tree: the first node (the CEO and CoS nodes when they are further left, for one department); grid: the trunk.
  const legendX = mode === 'grid' ? left - TRUNK_OFFSET : Math.min(ceo.x, ...cells.map((c) => c.x));
  return { mode, k, rows, width: W, height: tops[lastRow] + NODE_H + chipBlock[lastRow], spineX, ceo, cos, cosChips, cells, empty: null, edges, legendX };
}
