// The `send` IPC handler, apart from ipc.ts (which imports electron) so that it can be tested.
import { checkFiles, fileProblemText } from '../shared/attachments';
import { checkImages, imageProblemText } from '../shared/images';
import type { OrgManager } from './org/org-manager';
import type { CommandConfirm } from './org/org-session';
import { t } from '../shared/strings';
import type { FileAttachment, ImageAttachment, OrgId, ThreadId } from '../shared/types';

/**
 * The `send` handler. The renderer checks images and files early, but this is the check that counts: when any image
 * (type, bytes that do not match the type, size, count) or file (size per kind, count, total) fails the whole send is
 * dropped and an error is thrown. Text may be empty when an image or a file is attached; with none, empty text is ignored.
 */
export function sendMessage(d: { orgs: Pick<OrgManager, 'session'> }, orgId: OrgId, threadId: ThreadId, text: string, images?: unknown, files?: unknown): void {
  if (typeof text !== 'string') return;
  const list = images === undefined || images === null ? [] : images;
  if (!Array.isArray(list)) throw new Error(imageProblemText('format'));
  const problem = list.length > 0 ? checkImages(list) : null;
  if (problem) throw new Error(imageProblemText(problem));
  const fileList = files === undefined || files === null ? [] : files;
  const fileProblem = Array.isArray(fileList) && fileList.length === 0 ? null : checkFiles(fileList);
  if (fileProblem) throw new Error(fileProblemText(fileProblem));
  if (!text.trim() && list.length === 0 && (fileList as unknown[]).length === 0) return;
  d.orgs.session(orgId).send(threadId, text, undefined, list as ImageAttachment[], fileList as FileAttachment[]);
}

/**
 * The `runCommand` handler: only a string command and a known chat reach the session; the folder is always the org's
 * hq (the renderer has no way to name one). `confirm` is the native dialog in ipc.ts.
 */
export function runCommand(d: { orgs: Pick<OrgManager, 'session'> }, orgId: OrgId, threadId: ThreadId, command: unknown, confirm: (c: CommandConfirm) => Promise<boolean>): Promise<boolean> {
  if (typeof command !== 'string') return Promise.reject(new Error(t('command.problem.empty')));
  return d.orgs.session(orgId).runCommand(threadId, command, confirm);
}
