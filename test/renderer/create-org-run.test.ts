import { describe, expect, it } from 'vitest';
import { EMPTY_FACTS, type SetupFacts, type SetupState } from '../../src/shared/setup';
import type { ThreadEntry, ThreadInfo } from '../../src/shared/types';
import { folderUntouched, formatElapsed, initFleetCommand, lastAssistantText, looksLikeQuestion, mentionsNonEmptyFolder, milestones, problemStep, runPhase, runSteps, setupComplete, throttleStep } from '../../src/renderer/create-org-run';

const state = (p: Partial<SetupState> = {}): SetupState => ({ runId: 'r', busy: false, exited: false, hqReady: false, facts: EMPTY_FACTS, answersFile: '/tmp/a.yaml', error: null, ...p });
const entry = (kind: ThreadEntry['kind'], text: string, steps?: ThreadEntry['steps']): ThreadEntry => ({ id: text, kind, author: '', text, time: '2026-01-01T00:00:00Z', steps });
const thread = (entries: ThreadEntry[]): ThreadInfo => ({ orgId: 'setup', threadId: 'setup:r', busy: false, handoffsWaiting: 0, title: '', speaker: '', entries, streaming: '' });

describe('looksLikeQuestion', () => {
  it('sees a last line that ends in a question mark, through markdown marks', () => {
    expect(looksLikeQuestion('Here is the summary.\n\nShall I go on?')).toBe(true);
    expect(looksLikeQuestion('**Install the plugin for this folder?**')).toBe(true);
    expect(looksLikeQuestion('Save the first version (y/n)')).toBe(true);
  });
  it('does not see a closing report, an empty text or a question earlier in the message', () => {
    expect(looksLikeQuestion('Done. Your hq is ready.')).toBe(false);
    expect(looksLikeQuestion('Why?\nBecause it is done.')).toBe(false);
    expect(looksLikeQuestion(null)).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
  });
});

describe('setupComplete', () => {
  const f = (p: Partial<SetupFacts>): SetupFacts => ({ ...EMPTY_FACTS, ...p });
  it('needs state.md, the decision record and settings.json, or a first commit', () => {
    expect(setupComplete(EMPTY_FACTS)).toBe(false);
    expect(setupComplete(f({ orgYaml: true, state: true, settings: true }))).toBe(false);
    expect(setupComplete(f({ state: true, decisionRecord: true, settings: true }))).toBe(true);
    expect(setupComplete(f({ commit: 'abc1234' }))).toBe(true);
  });
});

describe('runPhase', () => {
  const ready = { hqReady: true, facts: { ...EMPTY_FACTS, orgYaml: true, state: true, decisionRecord: true, settings: true } };
  it('works while a turn runs, even when the hq is there', () => {
    expect(runPhase(null, null)).toBe('working');
    expect(runPhase(state({ busy: true, ...ready }), 'x')).toBe('working');
  });
  it('an error fails the run', () => {
    expect(runPhase(state({ error: 'boom', ...ready }), 'x')).toBe('failed');
  });
  it('is done when the folder shows the setup complete and the wizard ended without a question', () => {
    expect(runPhase(state(ready), 'All set.')).toBe('done');
    expect(runPhase(state({ hqReady: true, facts: { ...EMPTY_FACTS, commit: 'abc1234' } }), 'All set.')).toBe('done');
  });
  it('is not done when the hq is there but the folder does not show the setup complete: the wizard message and a reply box', () => {
    const half = { hqReady: true, facts: { ...EMPTY_FACTS, orgYaml: true, state: true } };
    expect(runPhase(state(half), 'I wrote the files. Tell me when I may go on')).toBe('asking');
    expect(runPhase(state({ hqReady: true }), 'Done.')).toBe('asking');
    expect(runPhase(state(half), null)).toBe('working');
  });
  it('shows the wizard message when it waits: a question, or no hq yet', () => {
    expect(runPhase(state(ready), 'Save the first version?')).toBe('asking');
    expect(runPhase(state(), 'Do you confirm the summary?')).toBe('asking');
  });
  it('waits when nothing was said yet; a process that ended with no hq failed', () => {
    expect(runPhase(state(), null)).toBe('working');
    expect(runPhase(state({ exited: true }), 'It stopped.')).toBe('failed');
  });
});

describe('mentionsNonEmptyFolder', () => {
  it('sees the wizard stopping on a directory that is not empty, in a few languages', () => {
    expect(mentionsNonEmptyFolder('The directory is not empty: it holds notes.txt. Do you want to continue?')).toBe(true);
    expect(mentionsNonEmptyFolder('This directory holds anything other than .git, so I stopped.')).toBe(true);
    expect(mentionsNonEmptyFolder('La cartella non \u00e8 vuota, contiene notes.txt.')).toBe(true);
    expect(mentionsNonEmptyFolder('Das Verzeichnis ist nicht leer.')).toBe(true);
  });
  it('does not see an ordinary question', () => {
    expect(mentionsNonEmptyFolder('Do you confirm the summary?')).toBe(false);
    expect(mentionsNonEmptyFolder(null)).toBe(false);
  });
});

describe('the terminal fallback and the step a problem belongs to', () => {
  const steps = ['language-profile', 'purpose-level', 'name-id', 'departments', 'names', 'summary', 'folder'] as const;
  it('builds the init-fleet command', () => {
    expect(initFleetCommand('/tmp/a/answers.yaml')).toBe('/ceo-of-agents:init-fleet /tmp/a/answers.yaml');
  });
  it('maps the schema key the wizard names to its step, through array indexes and longest known prefix', () => {
    expect(problemStep('The plugin reported invalid answers: departments[0].id must be kebab-case.', steps)).toBe('departments');
    expect(problemStep('org.id is reserved', steps)).toBe('name-id');
    expect(problemStep('names.departments.engineering is missing', steps)).toBe('names');
  });
  it('finds nothing in a text without a key of a listed step, or for a step that does not apply', () => {
    expect(problemStep('It broke at /tmp/x/org.yaml', steps)).toBeNull();
    expect(problemStep('gates.looser is invalid', steps)).toBeNull();
    expect(problemStep('', steps)).toBeNull();
  });
});

describe('what the folder shows', () => {
  it('ticks only on detected facts', () => {
    expect(milestones(EMPTY_FACTS).every((m) => !m.done)).toBe(true);
    expect(milestones({ ...EMPTY_FACTS, orgYaml: true, settings: true }).filter((m) => m.done).map((m) => m.id)).toEqual(['orgYaml', 'settings']);
  });
  it('allows Try again only while the folder holds nothing the wizard wrote', () => {
    expect(folderUntouched(EMPTY_FACTS)).toBe(true);
    expect(folderUntouched({ ...EMPTY_FACTS, state: true })).toBe(false);
    expect(folderUntouched({ ...EMPTY_FACTS, commit: 'abc1234' })).toBe(false);
  });
});

describe('the thread of the run', () => {
  it('finds the latest assistant message', () => {
    expect(lastAssistantText(undefined)).toBeNull();
    expect(lastAssistantText(thread([entry('assistant', 'one'), entry('user', 'Yes'), entry('assistant', 'two')]))).toBe('two');
  });
  it('lists tool lines and the steps of finished turns in order', () => {
    const th = thread([entry('tool', 'Reading answers'), entry('activity', '', [{ text: 'Wrote org.yaml' }, 'Wrote state.md'])]);
    expect(runSteps(th)).toEqual(['Reading answers', 'Wrote org.yaml', 'Wrote state.md']);
  });
});

describe('formatElapsed', () => {
  it('shows m:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(62_500)).toBe('1:02');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('throttleStep: one update per interval', () => {
  it('shows a new line at once when none was shown or the interval has passed', () => {
    expect(throttleStep({ shown: '', at: 0 }, 'a', 10, 2000).next).toEqual({ shown: 'a', at: 10 });
    expect(throttleStep({ shown: 'a', at: 0 }, 'b', 2500, 2000)).toEqual({ next: { shown: 'b', at: 2500 }, waitMs: 0 });
  });
  it('holds a new line until the interval is over and says how long to wait', () => {
    const prev = { shown: 'a', at: 1000 };
    expect(throttleStep(prev, 'b', 1500, 2000)).toEqual({ next: prev, waitMs: 1500 });
  });
  it('keeps the same state for the same line', () => {
    const prev = { shown: 'a', at: 1000 };
    expect(throttleStep(prev, 'a', 1100, 2000).next).toBe(prev);
  });
});
