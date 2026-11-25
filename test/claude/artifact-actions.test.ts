import { describe, expect, it } from 'vitest';
import { artifactAction, artifactActivity, artifactSummary, SAFE_ARTIFACT_ACTIONS } from '../../src/main/claude/artifact-actions';

const ID = 'Xk3m9Qw7RtB2nLp5VdHc4a'; // made up: 22 base58 characters
const UUID = '3f2b8c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b';
const url = `https://claude.ai/artifact/${ID}`;

describe('artifactAction', () => {
  it('publish: the title, else the file name, else nothing', () => {
    expect(artifactAction({ action: 'publish', file_path: '/abs/dir/page.html', title: 'Capture test', icon: 'code' })).toEqual({ action: 'publish', target: 'Capture test' });
    expect(artifactAction({ action: 'publish', file_path: '/abs/dir/page.html' })).toEqual({ action: 'publish', target: 'page.html' });
    expect(artifactAction({ action: 'publish' })).toEqual({ action: 'publish' });
  });
  it('url actions: the artifact id, for both URL forms and a uuid', () => {
    expect(artifactAction({ action: 'read', url })).toEqual({ action: 'read', target: ID });
    expect(artifactAction({ action: 'delete', url: `https://claude.ai/code/artifact/my-slug-prefix-${ID}` })).toEqual({ action: 'delete', target: ID });
    expect(artifactAction({ action: 'open', url: `https://claude.ai/artifact/${UUID}?x=1#y` })).toEqual({ action: 'open', target: UUID });
    expect(artifactAction({ action: 'read', url: `https://claude.ai/code/artifact/some-slug-${UUID}` })).toEqual({ action: 'read', target: UUID });
  });
  it('no target for list, a bad url or a url that is not text', () => {
    expect(artifactAction({ action: 'list' })).toEqual({ action: 'list' });
    expect(artifactAction({ action: 'read', url: 'not a url' })).toEqual({ action: 'read' });
    expect(artifactAction({ action: 'read', url: 5 })).toEqual({ action: 'read' });
  });
  it('a missing or non-text action is empty', () => {
    for (const v of [undefined, null, 'x', [], {}, { action: 3 }, { action: '  ' }]) expect(artifactAction(v)).toEqual({ action: '' });
  });
  it('ignores every __artifact field', () => {
    const input = { action: 'publish', file_path: '/a/p.html', title: 'T', __artifactPlanConsentAsk: true, __artifactPublishTarget: 'x', __artifactRoomJoinDisclosed: true, __artifactPublishSourcePin: 'y' };
    expect(artifactAction(input)).toEqual({ action: 'publish', target: 'T' });
    expect(artifactSummary(input)).not.toContain('__artifact');
  });
});

describe('artifactSummary', () => {
  it('publish', () => {
    expect(artifactSummary({ action: 'publish', file_path: '/abs/file.html', title: 'Capture test' })).toBe('Publish the artifact "Capture test"');
    expect(artifactSummary({ action: 'publish', file_path: '/abs/file.html' })).toBe('Publish the artifact "file.html"');
    expect(artifactSummary({ action: 'publish' })).toBe('Publish a new artifact');
  });
  it('actions on an artifact, with both URL forms', () => {
    expect(artifactSummary({ action: 'delete', url })).toBe(`Delete artifact ${ID}`);
    expect(artifactSummary({ action: 'read', url: `https://claude.ai/code/artifact/slug-${ID}` })).toBe(`Read artifact ${ID}`);
    expect(artifactSummary({ action: 'open', url })).toBe(`Open artifact ${ID}`);
    expect(artifactSummary({ action: 'pin', url })).toBe(`Pin artifact ${ID}`);
    expect(artifactSummary({ action: 'unpin', url })).toBe(`Unpin artifact ${ID}`);
    expect(artifactSummary({ action: 'share', url })).toBe(`Share artifact ${ID}`);
  });
  it('list, quickstart, an unknown action and a missing one', () => {
    expect(artifactSummary({ action: 'list' })).toBe('List your artifacts');
    expect(artifactSummary({ action: 'quickstart' })).toBe('Start a new artifact');
    expect(artifactSummary({ action: 'write_db' })).toBe('Artifact: write_db');
    expect(artifactSummary({ action: 'write_db', url })).toBe(`Artifact: write_db ${ID}`);
    expect(artifactSummary({ action: 'read' })).toBe('Artifact: read');
    expect(artifactSummary({})).toBe('Use the Artifact tool');
    expect(artifactSummary({ action: 7 })).toBe('Use the Artifact tool');
    expect(artifactSummary(undefined)).toBe('Use the Artifact tool');
  });
  it('caps a long title at about 80 characters', () => {
    const s = artifactSummary({ action: 'publish', title: 'T'.repeat(300) });
    expect(s).toBe(`Publish the artifact "${'T'.repeat(79)}…"`);
  });
  it('never shows raw JSON', () => {
    expect(artifactSummary({ action: 'publish', file_path: '/abs/file.html', title: 'A' })).not.toMatch(/[{}]|file_path/);
  });
});

describe('artifactActivity', () => {
  it('is short and plain', () => {
    expect(artifactActivity({ action: 'publish', title: 'Report' })).toBe('Publishing the artifact Report');
    expect(artifactActivity({ action: 'publish' })).toBe('Publishing an artifact');
    expect(artifactActivity({ action: 'read', url })).toBe(`Reading artifact ${ID}`);
    expect(artifactActivity({ action: 'list' })).toBe('Listing your artifacts');
    expect(artifactActivity({ action: 'delete', url })).toBe(`Deleting artifact ${ID}`);
    expect(artifactActivity({ action: 'open', url })).toBe(`Opening artifact ${ID}`);
    expect(artifactActivity({ action: 'read' })).toBe('Working on an artifact');
    expect(artifactActivity({ action: 'comments', url })).toBe('Working on an artifact');
    expect(artifactActivity({})).toBe('Working on an artifact');
  });
});

describe('SAFE_ARTIFACT_ACTIONS', () => {
  it('is read, list and open only', () => {
    expect([...SAFE_ARTIFACT_ACTIONS]).toEqual(['read', 'list', 'open']);
  });
});
