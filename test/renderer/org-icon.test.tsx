import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { orgIconKey } from '../../src/renderer/org-icon-cache';
import { orgIconNotice } from '../../src/renderer/settings-logic';
import { OrgIconOrInitials } from '../../src/renderer/OrgIcon';

describe('org icon helpers', () => {
  it('the cache key changes with the stamp and is null without one', () => {
    expect(orgIconKey('o1', '1-2')).toBe('o1|1-2');
    expect(orgIconKey('o1', '3-2')).not.toBe(orgIconKey('o1', '1-2'));
    expect(orgIconKey('o1', null)).toBeNull();
    expect(orgIconKey('o1', undefined)).toBeNull();
  });
  it('the notice after a pick', () => {
    expect(orgIconNotice(null)).toBeNull();
    expect(orgIconNotice({ ok: true })).toEqual({ kind: 'saved' });
    expect(orgIconNotice({ ok: false, error: 'tooLarge' })).toEqual({ kind: 'error', key: 'orgIcon.error.tooLarge' });
    expect(orgIconNotice({ ok: false, error: 'unsupported' })).toEqual({ kind: 'error', key: 'orgIcon.error.unsupported' });
  });
  it('shows the initials until the image has loaded', () => {
    expect(renderToStaticMarkup(<OrgIconOrInitials orgId="o1" iconStamp="1-2" name="ACME Corp" />)).toBe('AC');
  });
});
