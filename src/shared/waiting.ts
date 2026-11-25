// Counting and grouping of the pending list (plugin schemas state/1 and todo/1, "Parent and child items"). Pure, no React.
import type { WaitingEntry, WaitingItem } from './types';

/** A parsed item, not an unparsed line. */
export const isParsedWaiting = (e: WaitingEntry): e is WaitingItem => !('unparsed' in e);

/** A line that asks the CEO something: every parsed item except a `{wait}` group heading. */
export const asksTheCeo = (i: WaitingItem): boolean => i.action !== 'wait';

/** How many items wait on the CEO: parsed `ok`, `do`, `decide` and untagged lines, children included, `{wait}` headings left out. */
export const countAsks = (entries: readonly WaitingEntry[]): number => entries.filter((e) => isParsedWaiting(e) && asksTheCeo(e)).length;
