import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGates, pluginVersionAt, readSetupData } from '../../src/main/setup/plugin-data';

const PLUGIN = path.join(__dirname, '..', 'fixtures', 'setup-plugin');

describe('readSetupData', () => {
  const data = readSetupData(PLUGIN);

  it('reads the plugin version', () => {
    expect(data.pluginVersion).toBe('9.9.9');
    expect(pluginVersionAt(path.join(PLUGIN, 'nope'))).toBeNull();
  });

  it('lists the catalog in the plugin order, unknown ids last by name, and skips an entry without agent.md', () => {
    expect(data.catalog.map((c) => c.id)).toEqual(['engineering', 'legal', 'health', 'alpha', 'zeta']);
  });

  it('reads role and purpose, and flags advisory and personal-only entries', () => {
    const by = Object.fromEntries(data.catalog.map((c) => [c.id, c]));
    expect(by.engineering).toMatchObject({ role: 'Engineering', purpose: 'Own the engineering work of the org.', advisory: false, personalOnly: false });
    expect(by.legal).toMatchObject({ role: 'Legal', advisory: true, personalOnly: false });
    expect(by.health).toMatchObject({ advisory: true, personalOnly: true });
    // No "the X department of" sentence: the id is the role.
    expect(by.alpha.role).toBe('alpha');
  });

  it('reads the gate actions by tier with their meaning, and locks file-or-sign', () => {
    expect(data.gates.map((g) => [g.id, g.tier])).toEqual([
      ['read-things', 'free'],
      ['write-notes', 'free'],
      ['push-draft', 'notice'],
      ['ship-it', 'ok'],
      ['file-or-sign', 'ok'],
      ['no-meaning-action', 'ok'],
    ]);
    const by = Object.fromEntries(data.gates.map((g) => [g.id, g]));
    expect(by['ship-it']).toMatchObject({ meaning: 'Release something', example: 'release a new version', locked: false });
    expect(by['file-or-sign'].locked).toBe(true);
    expect(by['no-meaning-action']).toMatchObject({ meaning: '', example: '', locked: false });
  });

  it('gives the model tiers, most capable first', () => {
    expect(data.tiers).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('throws when there is neither catalog nor gates', () => {
    expect(() => readSetupData(path.join(PLUGIN, 'catalog', 'zeta'))).toThrow(/No catalog or gates/);
  });
});

describe('parseGates', () => {
  it('locks make-payment and ignores unknown tiers', () => {
    const text = '## The table\n\n| Tier | Rule | Action ids |\n|---|---|---|\n| ok | r | `make-payment` |\n| weird | r | `x-y` |\n';
    expect(parseGates(text)).toEqual([{ id: 'make-payment', tier: 'ok', meaning: '', example: '', locked: true }]);
  });
});
