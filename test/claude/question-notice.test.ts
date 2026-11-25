import { describe, expect, it } from 'vitest';
import { questionNotice } from '../../src/main/claude/question-notice';
import { t } from '../../src/shared/strings';

describe('questionNotice', () => {
  it('is the org name plus a fixed line: no question text, option or summary', () => {
    const request = { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Secret launch date?', options: [{ label: 'Tuesday' }] }] }, summary: 'Secret launch date?' };
    const n = questionNotice(request, 'Acme');
    expect(n).toEqual({ title: 'Acme', body: t('notification.question.body') });
    expect(JSON.stringify(n)).not.toMatch(/Secret|Tuesday/);
  });

  it('falls back to a generic title without an org name, and is null for any other tool', () => {
    expect(questionNotice({ toolName: 'AskUserQuestion' }, undefined)?.title).toBe(t('notification.question.title'));
    expect(questionNotice({ toolName: 'Bash' }, 'Acme')).toBeNull();
  });
});
