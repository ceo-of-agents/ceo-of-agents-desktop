import { describe, expect, it } from 'vitest';
import { isSpecificModel, modelLabel, tierOf } from '../src/shared/model-label';

describe('modelLabel', () => {
  it('reads family, major and minor', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelLabel('claude-opus-4-1')).toBe('Opus 4.1');
  });
  it('drops a date suffix', () => {
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4');
  });
  it('shows a [1m] suffix as 1M', () => {
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)');
    expect(modelLabel('claude-sonnet-4-5-20250929[1m]')).toBe('Sonnet 4.5 (1M)');
  });
  it('reads the older family-last shape', () => {
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('claude-3-haiku-20240307')).toBe('Haiku 3');
  });
  it('falls back to the id for shapes it does not know', () => {
    expect(modelLabel('opus')).toBe('opus');
    expect(modelLabel('anthropic.claude-opus-5-5-v1:0')).toBe('anthropic.claude-opus-5-5-v1:0');
    expect(modelLabel('claude-opus')).toBe('claude-opus');
    expect(modelLabel('')).toBe('');
  });
});

describe('model kinds', () => {
  it('tells a specific id from an alias', () => {
    expect(isSpecificModel('claude-opus-5-5')).toBe(true);
    expect(isSpecificModel('opus')).toBe(false);
    expect(isSpecificModel('opus[1m]')).toBe(false);
    expect(isSpecificModel(null)).toBe(false);
  });
  it('finds the tier of an alias or an id', () => {
    expect(tierOf('opus')).toBe('opus');
    expect(tierOf('sonnet[1m]')).toBe('sonnet');
    expect(tierOf('claude-haiku-5-5')).toBe('haiku');
    expect(tierOf('claude-3-5-sonnet')).toBe('sonnet');
    expect(tierOf('opusplan')).toBeNull();
    expect(tierOf(null)).toBeNull();
  });
});
