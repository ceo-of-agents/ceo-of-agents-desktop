import { ASK_USER_QUESTION } from '../../shared/questions';
import { t } from '../../shared/strings';

/**
 * The desktop notification for a pending AskUserQuestion call, or null for any other tool. Only the org name and a fixed line:
 * a notification can show on a locked screen, so it never carries the question, its options or the summary.
 */
export function questionNotice(request: { toolName: string }, orgName: string | undefined): { title: string; body: string } | null {
  if (request.toolName !== ASK_USER_QUESTION) return null;
  return { title: orgName ?? t('notification.question.title'), body: t('notification.question.body') };
}
