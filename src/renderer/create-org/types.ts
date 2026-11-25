import type { SetupData } from '../../shared/setup';
import type { Draft, PurposePatch } from '../create-org-logic';
import type { Errors } from './fields';

/** What every step body gets: the draft, the plugin data, the errors of the last Next, and how to change an answer. */
export interface StepProps {
  draft: Draft;
  data: SetupData;
  errors: Errors;
  /** Changes the draft: the function edits a copy. */
  update(fn: (d: Draft) => void): void;
  /** A purpose or level change: answers that no longer apply are dropped and the first affected step is marked. */
  changePurpose(patch: PurposePatch): void;
}
