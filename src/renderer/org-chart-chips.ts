// What fits in a department's chip row (org chart review S1). The row hangs from the dashed stub at the node's left
// + 12 px, starts 6 px to the right of it and stays inside the node's 200 px column; it never wraps. If it would pass
// the column edge, the model text goes first, then the extra chips fold into one "+{n}" chip.
//
// Widths are a FIXED PER-CHARACTER ESTIMATE, not a DOM measurement, so the choice is a pure function and does not
// wait for a layout pass. They are set a little above the real widths (11 px mono chips with 0.06em spacing, 12 px
// sans model text) so a row never overflows; the check is the test and the stills (READER WORKER Sonnet is about
// 166 px by this estimate and about 167 px in the review's stills).
import type { OrgChartWorker } from '../shared/types';
import { CHIPS_LEFT, NODE_W, STUB_LEFT } from './org-chart-layout';

/** The widest a chip row may be: the rest of the node's column after the stub (12 px) and the 6 px to the first chip. */
export const CHIP_ROW_MAX = NODE_W - STUB_LEFT - CHIPS_LEFT;
/** Between two chips, and between the last chip and the model. */
export const CHIP_GAP = 6;

const CHIP_CHAR_W = 7.3;
const CHIP_PAD_W = 14;
const MODEL_CHAR_W = 6.3;

/** Estimated width of a chip with this text (uppercase mono, 6 px padding and a 1 px border each side). */
export const chipWidth = (text: string): number => Math.ceil(text.length * CHIP_CHAR_W + CHIP_PAD_W);
/** Estimated width of the muted model text (12 px sans, `--fs-meta`); the role text beside it is the same font. */
export const modelWidth = (text: string): number => Math.ceil(text.length * MODEL_CHAR_W);

// Line 2 of a node (role left, model right). The text column is the node (200) minus its 1 px borders (2), padding
// (12 each side), the avatar (28) and the gap after it (10).
export const NODE_TEXT_W = NODE_W - 2 - 24 - 28 - 10;
/** The least space between the role and the model (`--sp-3`). */
export const ROLE_MODEL_GAP = 8;
// The estimate runs a little low for wide capitals ("Design and brand" + "Opus" measures about 139 px against 135
// estimated), and a cut role is worse than a missing model, so the pair must clear the column by this much.
const ROLE_MODEL_SLACK = 4;

/**
 * Does the model text show on line 2 of a node? The role wins: the model shows only when role, gap and model all fit
 * at full width; otherwise it is dropped (the tooltip and the accessible name still carry it) and only a role that
 * does not fit alone takes the ellipsis. No model: nothing to show. No role: the model has the line to itself.
 */
export function fitRoleModel(role: string, model: string, width: number = NODE_TEXT_W): boolean {
  if (!model) return false;
  if (!role) return true;
  return modelWidth(role) + ROLE_MODEL_GAP + modelWidth(model) + ROLE_MODEL_SLACK <= width;
}

export interface ChipFit {
  /** The chips drawn in full, in order. */
  shown: OrgChartWorker[];
  /** The chips folded into the "+{n}" chip (its tooltip names them); empty when none is folded. */
  folded: OrgChartWorker[];
  /** The model text after the chips. */
  showModel: boolean;
  /** Estimated width of the row. */
  width: number;
}

const rowWidth = (widths: number[]): number => widths.reduce((a, w) => a + w, 0) + Math.max(0, widths.length - 1) * CHIP_GAP;

export function fitChips(workers: OrgChartWorker[], models: string, maxWidth: number = CHIP_ROW_MAX): ChipFit {
  const all = workers.map((w) => chipWidth(w.name));
  const withModel = models ? [...all, modelWidth(models)] : all;
  if (rowWidth(withModel) <= maxWidth) return { shown: workers, folded: [], showModel: !!models, width: rowWidth(withModel) };
  // The model text goes first.
  if (rowWidth(all) <= maxWidth) return { shown: workers, folded: [], showModel: false, width: rowWidth(all) };
  // Then the extra chips fold into "+{n}": keep the most chips that fit with the "+n" chip after them (none: only "+n").
  for (let keep = workers.length - 1; keep >= 0; keep--) {
    const widths = [...all.slice(0, keep), chipWidth(`+${workers.length - keep}`)];
    if (rowWidth(widths) <= maxWidth) return { shown: workers.slice(0, keep), folded: workers.slice(keep), showModel: false, width: rowWidth(widths) };
  }
  return { shown: [], folded: workers, showModel: false, width: chipWidth(`+${workers.length}`) };
}
