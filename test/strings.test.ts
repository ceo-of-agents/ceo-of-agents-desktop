import { describe, expect, it } from 'vitest';
import { t } from '../src/shared/strings';

describe('t', () => {
  it('fills placeholders', () => {
    expect(t('cos.msg.approve', { code: 'X-A1' })).toBe('approve X-A1');
  });
  it('returns the key when unknown', () => {
    expect(t('nope.key')).toBe('nope.key');
  });
});
