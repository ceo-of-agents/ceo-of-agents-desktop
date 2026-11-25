import { describe, expect, it } from 'vitest';
import { locateClaude } from '../../src/main/system/locate';
import { fail, mockRunner, ok } from './helpers';

describe('locateClaude', () => {
  it('dev override wins', async () => {
    expect(await locateClaude({ devBin: '/dev/claude', isExecutable: () => false })).toBe('/dev/claude');
  });
  it('first usual dir', async () => {
    const r = await locateClaude({ devBin: null, dirs: ['/a', '/b'], isExecutable: (p) => p === '/b/claude' || p === '/a/claude' });
    expect(r).toBe('/a/claude');
  });
  it('falls back to login shell', async () => {
    const { runner, calls } = mockRunner(() => ok('/opt/x/claude\n'));
    const r = await locateClaude({ devBin: null, dirs: ['/a'], isExecutable: (p) => p === '/opt/x/claude', runner });
    expect(r).toBe('/opt/x/claude');
    expect(calls[0]).toMatchObject({ cmd: '/bin/zsh', args: ['-lc', 'command -v claude'] });
  });
  it('null when nowhere', async () => {
    const { runner } = mockRunner(() => fail('', 1));
    expect(await locateClaude({ devBin: null, dirs: ['/a'], isExecutable: () => false, runner })).toBeNull();
  });
});
