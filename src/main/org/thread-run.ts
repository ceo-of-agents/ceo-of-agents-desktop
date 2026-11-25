// What the user chose for one chat: its model and reasoning effort. Kept by the app, per org, in
// <orgDataDir>/thread-run.json keyed by thread id ("cos", "tab:<id>"). A missing value means "org default".
import path from 'node:path';
import { readJsonObject, writeFileAtomic } from '../claude/local-settings';
import { EFFORTS, isModel } from '../settings';
import type { EffortLevel, RunChoice, ThreadId } from '../../shared/types';

export const NO_CHOICE: RunChoice = { model: null, effort: null };

/** Pure: what a chat runs on. COA_MODEL (development) wins, then the chat's choice, then the org default. */
export function resolveRun(i: { choice: RunChoice; orgModel: string | null; orgEffort: EffortLevel; devModel?: string | null }): { model: string | null; effort: EffortLevel } {
  return { model: i.devModel || i.choice.model || i.orgModel, effort: i.choice.effort ?? i.orgEffort };
}

export class ThreadRunStore {
  private readonly file: string;
  private data: Record<string, RunChoice> | null = null;

  constructor(orgDataDir: string) {
    this.file = path.join(orgDataDir, 'thread-run.json');
  }

  private load(): Record<string, RunChoice> {
    if (this.data) return this.data;
    const out: Record<string, RunChoice> = {};
    for (const [id, v] of Object.entries(readJsonObject(this.file))) {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      const model = isModel(o.model) ? o.model : null;
      const effort = EFFORTS.includes(o.effort as EffortLevel) ? (o.effort as EffortLevel) : null;
      if (model || effort) out[id] = { model, effort };
    }
    this.data = out;
    return out;
  }

  get(threadId: ThreadId): RunChoice {
    return { ...(this.load()[threadId] ?? NO_CHOICE) };
  }

  /** Applies the keys present in `patch` (null: back to the org default); invalid values are ignored. Returns the new choice. */
  set(threadId: ThreadId, patch: { model?: string | null; effort?: EffortLevel | null }): RunChoice {
    const all = this.load();
    const next = this.get(threadId);
    if (patch.model === null || isModel(patch.model)) next.model = patch.model;
    if (patch.effort === null || EFFORTS.includes(patch.effort as EffortLevel)) next.effort = patch.effort as EffortLevel | null;
    if (next.model || next.effort) all[threadId] = next;
    else delete all[threadId];
    writeFileAtomic(this.file, JSON.stringify(all, null, 2) + '\n');
    return { ...next };
  }
}
