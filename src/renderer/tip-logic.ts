// The contextual tip in the side panel: what a click puts in the chief of staff's box.

/**
 * What a click puts in the composer: the phrase, with the "..." part (the user completes it) selected, else the cursor at the end.
 * A box that already has text is never overwritten: the phrase goes on a new line after it (no extra newline when the text already
 * ends with one) and the selection moves with it.
 */
export function phraseInsertion(phrase: string, draft = ''): { text: string; selStart: number; selEnd: number } {
  const head = draft.trim() === '' ? '' : draft.endsWith('\n') ? draft : `${draft}\n`;
  const at = phrase.indexOf('...');
  const [selStart, selEnd] = at >= 0 ? [at, at + 3] : [phrase.length, phrase.length];
  return { text: head + phrase, selStart: head.length + selStart, selEnd: head.length + selEnd };
}

/** The tip after `id` in the list, wrapping to the start; the first tip when `id` is not in it; null for an empty list. */
export function nextTip<T extends { id: string }>(tips: readonly T[], id: string | null): T | null {
  if (tips.length === 0) return null;
  const i = tips.findIndex((x) => x.id === id);
  return tips[(i + 1) % tips.length];
}

/** "Got it": the list without `id`, and the tip that followed it (the first one if it was last; null when none is left). */
export function afterGotIt<T extends { id: string }>(tips: readonly T[], id: string): { tips: T[]; current: T | null } {
  const i = tips.findIndex((x) => x.id === id);
  const rest = tips.filter((x) => x.id !== id);
  if (rest.length === 0) return { tips: rest, current: null };
  return { tips: rest, current: rest[i < 0 ? 0 : i % rest.length] };
}
