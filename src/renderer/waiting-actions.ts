// What Approve, Decline, Done and an option do on a waiting item, for the side panel card and the focus view alike:
// start the 4 s undo window and, when it ends, send the message to the chief of staff.
import { t } from '../shared/strings';
import { api } from './api';
import { pendingStore, type PendingKind } from './pending-send';

const MESSAGE: Record<PendingKind, string> = { approve: 'cos.msg.approve', decline: 'cos.msg.decline', done: 'cos.msg.done', option: 'cos.msg.option' };

export function startWaitingAction(orgId: string, code: string, kind: PendingKind, optionKey?: string): boolean {
  const message = t(MESSAGE[kind], { code, key: optionKey ?? '' });
  return pendingStore.start(orgId, code, kind, optionKey, () => api().send(orgId, 'cos', message));
}
