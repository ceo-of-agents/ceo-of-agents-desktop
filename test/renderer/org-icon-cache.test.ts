import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrgIcon, orgIconCacheSize } from '../../src/renderer/org-icon-cache';

const getOrgIcon = vi.fn();
beforeEach(() => {
  getOrgIcon.mockReset();
  getOrgIcon.mockImplementation((id: string) => Promise.resolve(`data:${id}`));
  vi.stubGlobal('window', { coa: { getOrgIcon } });
});
afterEach(() => vi.unstubAllGlobals());

describe('org icon cache', () => {
  it('one fetch per org and stamp', async () => {
    const before = orgIconCacheSize();
    expect(await loadOrgIcon('c-a', '1-1')).toBe('data:c-a');
    expect(await loadOrgIcon('c-a', '1-1')).toBe('data:c-a');
    expect(getOrgIcon).toHaveBeenCalledTimes(1);
    expect(orgIconCacheSize()).toBe(before + 1);
  });
  it('a new stamp evicts the previous entry of the same org, and only of that org', async () => {
    const before = orgIconCacheSize();
    await loadOrgIcon('e-a', '1-1');
    await loadOrgIcon('e-b', '1-1');
    expect(orgIconCacheSize()).toBe(before + 2);
    await loadOrgIcon('e-a', '2-1');
    await loadOrgIcon('e-a', '3-1');
    expect(orgIconCacheSize()).toBe(before + 2); // e-a holds one entry, e-b is untouched
    await loadOrgIcon('e-b', '1-1');
    expect(getOrgIcon).toHaveBeenCalledTimes(4); // e-b still cached
    getOrgIcon.mockClear();
    await loadOrgIcon('e-a', '1-1'); // the old stamp was dropped: fetched again
    expect(getOrgIcon).toHaveBeenCalledTimes(1);
  });
  it('no stamp: null, nothing cached', async () => {
    const before = orgIconCacheSize();
    expect(await loadOrgIcon('n-a', null)).toBeNull();
    expect(orgIconCacheSize()).toBe(before);
  });
  it('a miss is not kept', async () => {
    getOrgIcon.mockResolvedValueOnce(null);
    const before = orgIconCacheSize();
    expect(await loadOrgIcon('m-a', '1-1')).toBeNull();
    expect(orgIconCacheSize()).toBe(before);
    expect(await loadOrgIcon('m-a', '1-1')).toBe('data:m-a');
  });
});
