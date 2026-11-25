import { describe, expect, it } from 'vitest';
import { compareVersions, inRange, parseVersion, rangeLabel } from '../../src/main/system/version';

describe('version', () => {
  it('parses the first x.y.z', () => {
    expect(parseVersion('2.1.326 (Claude Code)')).toBe('2.1.326');
    expect(parseVersion('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5');
    expect(parseVersion('nothing')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
  it('compares numerically', () => {
    expect(compareVersions('2.1.326', '2.1.326')).toBe(0);
    expect(compareVersions('0.9.0', '0.13.0')).toBe(-1);
    expect(compareVersions('2.2.0', '2.1.999')).toBe(1);
  });
  it('checks ranges', () => {
    expect(inRange('2.1.326', '2.1.326', '2.2.0')).toBe(true);
    expect(inRange('2.1.325', '2.1.326', '2.2.0')).toBe(false);
    expect(inRange('2.2.0', '2.1.326', '2.2.0')).toBe(false);
  });
  it('labels ranges', () => {
    expect(rangeLabel('2.1.326', '2.2.0')).toBe('>=2.1.326 <2.2.0');
  });
});
