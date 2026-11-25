import { describe, expect, it } from 'vitest';
import { copyParts } from '../../src/renderer/DraftForm';
import { choiceValue, draftOptions, initialModel, localDate, OTHER, voiceSaveText } from '../../src/renderer/voice-logic';
import { parseVoice, voiceChannels, voiceModel, voiceTemplate } from '../../src/shared/voice';

describe('voice-logic', () => {
  it('formats the local date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('starts from the template when there is no file', () => {
    expect(initialModel({ exists: false, text: '' }, '2026-02-02')).toEqual({ base: '', channels: [], audiences: [] });
  });
  it('saves nothing when an existing file did not change, and a new file from the template when there is none', () => {
    const text = voiceTemplate('2026-01-01');
    const m = initialModel({ exists: true, text }, '2026-02-02');
    expect(voiceSaveText({ exists: true, text }, m, '2026-02-02')).toBeNull();
    const created = voiceSaveText({ exists: false, text: '' }, m, '2026-02-02');
    expect(created).toContain('last_updated: 2026-02-02');
    expect(created).toContain('## How to use this file');
  });
  it('sets last_updated and keeps the rest when something changed', () => {
    const text = voiceTemplate('2026-01-01');
    const out = voiceSaveText({ exists: true, text }, { base: '- Short.', channels: [{ name: 'Slack', text: '- No greeting.' }], audiences: [] }, '2026-02-02');
    expect(out).toContain('last_updated: 2026-02-02');
    expect(out).toContain('## How to use this file');
    expect(voiceChannels(out ?? '')).toEqual(['Slack']);
    expect(voiceModel(parseVoice(out ?? '')).base).toBe('- Short.');
  });
  it('offers the names of the file, or none without a file', () => {
    expect(draftOptions(null)).toEqual({ channels: [], audiences: [] });
    expect(draftOptions({ exists: false, text: 'x' })).toEqual({ channels: [], audiences: [] });
    expect(draftOptions({ exists: true, text: '## Channels\n\n### Slack\n\n## Audiences\n\n### Peers\n' })).toEqual({ channels: ['Slack'], audiences: ['Peers'] });
  });
  it('a choice is the picked name or the typed text', () => {
    expect(choiceValue('Slack', 'ignored')).toBe('Slack');
    expect(choiceValue('', 'ignored')).toBe('');
    expect(choiceValue(OTHER, '  Teams ')).toBe('Teams');
  });
  it('copy copies exactly the draft; mail copies subject and body apart', () => {
    expect(copyParts({ text: 'Hi *all*', subject: null, body: 'Hi *all*' })).toEqual([{ key: 'all', label: 'Copy', text: 'Hi *all*' }]);
    expect(copyParts({ text: 'Subject: S\n\nB', subject: 'S', body: 'B' })).toEqual([
      { key: 'subject', label: 'Copy subject', text: 'S' },
      { key: 'body', label: 'Copy body', text: 'B' },
    ]);
  });
});
