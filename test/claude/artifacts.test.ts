import { describe, expect, it } from 'vitest';
import { artifactEnv } from '../../src/main/claude/artifacts';

const ON = { CLAUDE_CODE_ARTIFACT: '1' };

describe('artifactEnv', () => {
  it('turns the artifact tools on by default', () => {
    expect(artifactEnv({}, {})).toEqual(ON);
    expect(artifactEnv(undefined, {})).toEqual(ON);
  });
  it('stays on when enableArtifact is anything but false', () => {
    expect(artifactEnv({ enableArtifact: true }, {})).toEqual(ON);
    expect(artifactEnv({ enableArtifact: 'false' }, {})).toEqual(ON);
  });
  it('returns {} when the user settings have enableArtifact false', () => {
    expect(artifactEnv({ enableArtifact: false }, {})).toEqual({});
  });
  it('returns {} when the settings env block disables artifacts with a truthy value', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', ' on ', 1, true]) expect(artifactEnv({ env: { CLAUDE_CODE_DISABLE_ARTIFACT: v } }, {})).toEqual({});
  });
  it('does not count empty, 0 or false (any case) in the settings env block as a disable', () => {
    for (const v of ['', '0', 'false', 'False', 'FALSE', 0, false, null]) expect(artifactEnv({ env: { CLAUDE_CODE_DISABLE_ARTIFACT: v } }, {})).toEqual(ON);
  });
  it('leaves a CLAUDE_CODE_ARTIFACT already in the process env alone, whatever its value', () => {
    expect(artifactEnv({}, { CLAUDE_CODE_ARTIFACT: '1' })).toEqual({});
    expect(artifactEnv({}, { CLAUDE_CODE_ARTIFACT: '0' })).toEqual({});
    expect(artifactEnv({}, { CLAUDE_CODE_ARTIFACT: '' })).toEqual({});
  });
  it('needs no handling for CLAUDE_CODE_DISABLE_ARTIFACT in the process env (it passes through and Claude Code honours it)', () => {
    expect(artifactEnv({}, { CLAUDE_CODE_DISABLE_ARTIFACT: '1' })).toEqual(ON);
  });
  it('treats malformed settings as not disabled', () => {
    for (const s of [null, 'x', 5, [], [{ enableArtifact: false }], { env: 'x' }, { env: [] }, { env: null }]) expect(artifactEnv(s, {})).toEqual(ON);
  });
});
