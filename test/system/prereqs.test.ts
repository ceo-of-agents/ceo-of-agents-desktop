import { afterEach, describe, expect, it } from 'vitest';
import { checkClaude, checkGit, checkPrereqs, checkSignedIn } from '../../src/main/system/prereqs';
import { ALLOW_UNSUPPORTED_ENV } from '../../src/main/config';
import { fail, fixture, mockRunner, ok } from './helpers';

afterEach(() => {
  delete process.env[ALLOW_UNSUPPORTED_ENV];
});

describe('checkClaude', () => {
  it('not found', async () => {
    const { runner } = mockRunner(() => ok());
    expect(await checkClaude(null, runner)).toMatchObject({ found: false, supported: false, range: '>=2.1.326 <2.2.0' });
  });
  it('supported', async () => {
    const { runner } = mockRunner(() => ok('2.1.326 (Claude Code)\n'));
    expect(await checkClaude('/x/claude', runner)).toMatchObject({ found: true, version: '2.1.326', supported: true });
  });
  it('unsupported, and forced by env', async () => {
    const { runner } = mockRunner(() => ok('2.2.1 (Claude Code)'));
    expect((await checkClaude('/x/claude', runner)).supported).toBe(false);
    process.env[ALLOW_UNSUPPORTED_ENV] = '1';
    expect((await checkClaude('/x/claude', runner)).supported).toBe(true);
  });
  it('unreadable version', async () => {
    const { runner } = mockRunner(() => fail('boom'));
    expect(await checkClaude('/x/claude', runner)).toMatchObject({ found: true, version: null, supported: false });
  });
});

describe('checkSignedIn', () => {
  it('true and false from fixtures', async () => {
    expect(await checkSignedIn('/c', mockRunner(() => ok(fixture('auth-status-in.json'))).runner)).toBe(true);
    expect(await checkSignedIn('/c', mockRunner(() => fail('', 1, fixture('auth-status-out.json'))).runner)).toBe(false);
  });
  it('garbage is false', async () => {
    expect(await checkSignedIn('/c', mockRunner(() => ok('not json')).runner)).toBe(false);
    expect(await checkSignedIn('/c', mockRunner(() => ok('null')).runner)).toBe(false);
    expect(await checkSignedIn('/c', mockRunner(() => ok('{"loggedIn":"yes"}')).runner)).toBe(false);
  });
  it('returns nothing but the boolean', async () => {
    const v = await checkSignedIn('/c', mockRunner(() => ok(fixture('auth-status-in.json'))).runner);
    expect(typeof v).toBe('boolean');
    expect(JSON.stringify(v)).toBe('true');
  });
});

describe('checkGit', () => {
  it('never runs git when devtools are missing', async () => {
    const { runner, calls } = mockRunner((l) => (l.startsWith('xcode-select') ? fail('error') : ok('git version 2.0.0')));
    expect(await checkGit(runner)).toEqual({ found: false, version: null, devToolsMissing: true });
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
  });
  it('finds git', async () => {
    const { runner } = mockRunner((l) => (l.startsWith('xcode-select') ? ok('/Library/Developer/CommandLineTools') : ok('git version 2.39.5 (Apple Git-154)')));
    expect(await checkGit(runner)).toEqual({ found: true, version: '2.39.5', devToolsMissing: false });
  });
});

describe('checkPrereqs', () => {
  it('plugin is null without hqPath', async () => {
    const { runner } = mockRunner((l) => {
      if (l.startsWith('/x/claude --version')) return ok('2.1.326 (Claude Code)');
      if (l.startsWith('/x/claude auth')) return ok(fixture('auth-status-in.json'));
      if (l.startsWith('xcode-select')) return ok('/p');
      if (l.startsWith('git')) return ok('git version 2.39.5');
      return undefined;
    });
    const s = await checkPrereqs({ hqPath: null, runner, claudePath: '/x/claude' });
    expect(s.plugin).toBeNull();
    expect(s.signedIn).toBe(true);
    expect(s.claude.supported).toBe(true);
    expect(s.git.found).toBe(true);
  });
  it('signedIn is null without claude', async () => {
    const { runner } = mockRunner(() => fail());
    const s = await checkPrereqs({ hqPath: '/x', runner, claudePath: null });
    expect(s.signedIn).toBeNull();
    expect(s.plugin).toBeNull();
  });
});
