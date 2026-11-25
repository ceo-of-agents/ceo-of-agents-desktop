// Chat tables: a short one-word cell (a code like ACME-A12, a date, a branch name) is kept on one line,
// so a narrow column never splits it at a hyphen or a slash. Longer text wraps at spaces as usual; a table wider
// than the thread scrolls sideways.

/** Longest one-word cell kept on one line. */
export const WHOLE_CELL_MAX = 24;

/** True for a cell whose text is one word of at most `WHOLE_CELL_MAX` characters. */
export function keepCellWhole(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= WHOLE_CELL_MAX && !/\s/.test(t);
}

interface HastLike {
  type?: string;
  value?: unknown;
  children?: unknown;
}

/** The plain text of a hast node (react-markdown's `node`). */
export function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as HastLike;
  if (n.type === 'text' && typeof n.value === 'string') return n.value;
  return Array.isArray(n.children) ? n.children.map(hastText).join('') : '';
}
