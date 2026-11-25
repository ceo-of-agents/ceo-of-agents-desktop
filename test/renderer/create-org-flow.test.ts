import { describe, expect, it } from 'vitest';
import en from '../../src/shared/strings/en.json';
import { firstInvalid, fieldId, hasAnswers, keepListed, nextLabelKey, nextStep, prevStep, shortList, stepClickable, stepLabelKey, stepNumber, stepState } from '../../src/renderer/create-org-flow';
import { emptyDraft, STEP_IDS, stepsFor } from '../../src/renderer/create-org-logic';
import type { SetupData } from '../../src/shared/setup';

const table = en as Record<string, string>;
const data: SetupData = { pluginVersion: '0.19.0', catalog: [], gates: [], tiers: ['opus', 'sonnet', 'haiku'] };

describe('step list states', () => {
  it('current wins, then needs attention, then done, else not visited', () => {
    expect(stepState('about', 'about', ['about'], ['about'])).toBe('current');
    expect(stepState('names', 'about', ['names'], ['names'])).toBe('attention');
    expect(stepState('names', 'about', ['names'], [])).toBe('done');
    expect(stepState('names', 'about', [], [])).toBe('todo');
  });
  it('a step not visited yet is not clickable; a visited one is, even when it was left with Back', () => {
    expect(stepClickable('todo', false)).toBe(false);
    expect(stepClickable('todo', true)).toBe(true);
    expect(stepClickable('done', false)).toBe(true);
    expect(stepClickable('attention', false)).toBe(true);
  });
  it('every step has a label in en.json', () => {
    for (const s of STEP_IDS) expect(table[stepLabelKey(s)], s).toBeTruthy();
  });
});

describe('moving', () => {
  const steps = stepsFor({ ...emptyDraft(), purpose: 'personal', level: 'company' });
  it('goes to the next and previous listed step and stops at the ends', () => {
    expect(steps).not.toContain('policy');
    expect(nextStep(steps, 'models')).toBe('repos-attribution');
    expect(prevStep(steps, 'repos-attribution')).toBe('models');
    expect(prevStep(steps, steps[0])).toBeNull();
    expect(nextStep(steps, 'folder')).toBeNull();
  });
  it('counts steps from 1, 0 when not listed', () => {
    expect(stepNumber(steps, 'language-profile')).toBe(1);
    expect(stepNumber(steps, 'policy')).toBe(0);
  });
  it('drops steps that are no longer listed', () => {
    expect(keepListed(['policy', 'models'], steps)).toEqual(['models']);
  });
  it('labels the footer button', () => {
    expect(nextLabelKey('about', false)).toBe('createOrg.next');
    expect(nextLabelKey('about', true)).toBe('createOrg.backToSummary');
    expect(nextLabelKey('summary', true)).toBe('createOrg.chooseFolder');
    expect(nextLabelKey('folder', false)).toBe('createOrg.create');
  });
});

describe('answers and checks', () => {
  it('a blank draft has no answers; any change counts', () => {
    expect(hasAnswers(emptyDraft())).toBe(false);
    expect(hasAnswers({ ...emptyDraft(), name: 'Acme' })).toBe(true);
  });
  it('finds the first listed step that does not validate', () => {
    const r = firstInvalid(emptyDraft(), data);
    expect(r?.step).toBe('language-profile');
    expect(r?.errors['language.chat']).toBeTruthy();
  });
  it('shows up to 5 entries and counts the rest', () => {
    expect(shortList(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(shortList(['1', '2', '3', '4', '5', '6', '7'])).toEqual({ shown: ['1', '2', '3', '4', '5'], more: 2 });
  });
  it('turns a field key into a DOM id', () => {
    expect(fieldId('departments.custom.0.id')).toBe('co-departments-custom-0-id');
  });
});
