import { describe, expect, it } from 'vitest';
import { appUpdateView, initialState, reducer } from '../../src/renderer/logic';
import type { AppUpdateState, AppUpdateStatus } from '../../src/shared/types';

const st = (state: AppUpdateState, over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({ state, current: '0.1.0', latest: '0.2.0', error: null, ...over });

describe('appUpdateView', () => {
  it('is hidden for idle, dev, no status or no known latest', () => {
    expect(appUpdateView(null)).toBeNull();
    expect(appUpdateView(st('idle'))).toBeNull();
    expect(appUpdateView(st('dev'))).toBeNull();
    expect(appUpdateView(st('available', { latest: null }))).toBeNull();
  });
  it('available offers Update app with both versions in the title', () => {
    expect(appUpdateView(st('available'))).toMatchObject({ button: 'Update app', title: 'Version 0.2.0 is available (you have 0.1.0)', disabled: false, busy: false, error: null });
  });
  it('downloading is busy and disabled', () => {
    expect(appUpdateView(st('downloading'))).toMatchObject({ label: 'Downloading update…', disabled: true, busy: true });
  });
  it('ready reads Restart to update and can be clicked', () => {
    expect(appUpdateView(st('ready'))).toMatchObject({ button: 'Restart to update', disabled: false, busy: false });
  });
  it('error shows the message and Try again', () => {
    expect(appUpdateView(st('error', { error: 'nope' }))).toMatchObject({ button: 'Try again', error: 'nope', disabled: false });
  });
});

describe('reducer app-update', () => {
  it('stores the status', () => {
    expect(reducer(initialState, { type: 'app-update', status: st('available') }).appUpdate).toEqual(st('available'));
  });
});
