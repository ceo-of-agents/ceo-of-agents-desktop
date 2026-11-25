import { describe, expect, it } from 'vitest';
import { buildAnswers, displayLabel, isQuestionRequest, isRecommended, parseQuestions, type Question } from '../../src/shared/questions';

const opt = (label: string, description = '') => ({ label, description });
const single = { question: 'Which database?', header: 'Database', multiSelect: false, options: [opt('SQLite (Recommended)', 'Local'), opt('Postgres'), opt('MySQL')] };
const multi = { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [opt('Lint'), opt('Tests'), opt('Types')] };

describe('parseQuestions', () => {
  it('accepts a valid input and fills the defaults', () => {
    const qs = parseQuestions({ questions: [single, { question: 'Plain?', options: [{ label: 'Yes' }] }] });
    expect(qs).toHaveLength(2);
    expect(qs?.[0]).toEqual(single);
    expect(qs?.[1]).toEqual({ question: 'Plain?', header: '', multiSelect: false, options: [{ label: 'Yes', description: '' }] });
  });
  it('keeps a plain-text preview', () => {
    const qs = parseQuestions({ questions: [{ question: 'Q?', options: [{ label: 'A', description: '', preview: 'x = 1' }] }] });
    expect(qs?.[0].options[0].preview).toBe('x = 1');
  });
  it('rejects wrong shapes', () => {
    const bad: unknown[] = [
      null, 'x', [], {}, { questions: 'x' }, { questions: [] },
      { questions: [single, single, single, single, single] },
      { questions: [{ ...single, question: '  ' }] },
      { questions: [{ ...single, question: 5 }] },
      { questions: [{ ...single, header: 5 }] },
      { questions: [{ ...single, multiSelect: 'yes' }] },
      { questions: [{ ...single, options: [] }] },
      { questions: [{ ...single, options: 'x' }] },
      { questions: [{ ...single, options: [opt('A'), opt('A')] }] },
      { questions: [{ ...single, options: [{ label: '' }] }] },
      { questions: [{ ...single, options: [{ label: 'A', description: 3 }] }] },
      { questions: [single, single] }, // same question text twice
    ];
    for (const b of bad) expect(parseQuestions(b)).toBeNull();
  });
});

describe('isQuestionRequest', () => {
  it('needs the tool name and a valid input', () => {
    expect(isQuestionRequest({ toolName: 'AskUserQuestion', input: { questions: [single] } })).toBe(true);
    expect(isQuestionRequest({ toolName: 'AskUserQuestion', input: {} })).toBe(false);
    expect(isQuestionRequest({ toolName: 'Bash', input: { questions: [single] } })).toBe(false);
  });
});

describe('isRecommended and displayLabel', () => {
  it('detects and strips a trailing (Recommended)', () => {
    expect(isRecommended('SQLite (Recommended)')).toBe(true);
    expect(isRecommended('sqlite (recommended) ')).toBe(true);
    expect(isRecommended('Recommended setup')).toBe(false);
    expect(displayLabel('SQLite (Recommended)')).toBe('SQLite');
    expect(displayLabel('Postgres')).toBe('Postgres');
    expect(displayLabel('(Recommended)')).toBe('(Recommended)');
  });
});

describe('buildAnswers', () => {
  const qs = [single, multi] as Question[];
  it('is null while a question is unanswered', () => {
    expect(buildAnswers(qs, [])).toBeNull();
    expect(buildAnswers(qs, [{ labels: ['Postgres'], other: '' }, { labels: [], other: '' }])).toBeNull();
    expect(buildAnswers(qs, [{ labels: [], other: '  ' }, { labels: ['Lint'], other: '' }])).toBeNull();
  });
  it('single choice gives the label as sent', () => {
    expect(buildAnswers([single], [{ labels: ['SQLite (Recommended)'], other: '' }])).toEqual({ 'Which database?': 'SQLite (Recommended)' });
  });
  it('multi-select joins in option order, then the Other text', () => {
    expect(buildAnswers([multi], [{ labels: ['Types', 'Lint'], other: ' e2e ' }])).toEqual({ 'Which checks?': 'Lint, Types, e2e' });
    expect(buildAnswers([multi], [{ labels: [], other: 'only this' }])).toEqual({ 'Which checks?': 'only this' });
  });
  it('Other replaces a single choice', () => {
    expect(buildAnswers([single], [{ labels: ['Postgres'], other: 'DuckDB' }])).toEqual({ 'Which database?': 'DuckDB' });
  });
  it('ignores labels that are not options', () => {
    expect(buildAnswers([single], [{ labels: ['Oracle'], other: '' }])).toBeNull();
  });
});
