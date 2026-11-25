import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionCard } from '../../src/renderer/ThreadView';
import { t } from '../../src/shared/strings';
import type { PermissionRequest } from '../../src/shared/types';

const req = (rule: string): PermissionRequest => ({ requestId: 'r1', threadKey: 'o|cos', orgId: 'o', threadId: 'cos', toolName: 'Bash', input: {}, summary: 'Run: x', rule }) as never;

describe('PermissionCard: Artifact', () => {
  it('a publish card shows the summary and has no Always allow', () => {
    const request = { ...req(''), toolName: 'Artifact', input: { action: 'publish', title: 'Capture test' }, summary: 'Publish the artifact "Capture test"' } as PermissionRequest;
    const html = renderToStaticMarkup(<PermissionCard request={request} onOpenSettings={() => undefined} />);
    expect(html).toContain('Publish the artifact &quot;Capture test&quot;');
    expect(html).not.toContain('rule-input');
    expect(html).not.toContain(t('permission.always'));
    expect(html).toContain(t('permission.allow'));
  });
});

describe('PermissionCard', () => {
  it('shows the rule input and Always allow when there is a proposal', () => {
    const html = renderToStaticMarkup(<PermissionCard request={req('Bash(ls *)')} onOpenSettings={() => undefined} />);
    expect(html).toContain('rule-input');
    expect(html).toContain(t('permission.always'));
  });
  it('hides both when there is no proposal; Allow and Deny stay', () => {
    const html = renderToStaticMarkup(<PermissionCard request={req('')} onOpenSettings={() => undefined} />);
    expect(html).not.toContain('rule-input');
    expect(html).not.toContain(t('permission.always'));
    expect(html).toContain(t('permission.allow'));
    expect(html).toContain(t('permission.deny'));
  });
  it('an AskUserQuestion that could not be shown as a card has no Allow: its one button asks Claude to use the chat', () => {
    const q = { ...req(''), toolName: 'AskUserQuestion', input: { questions: [] }, summary: 'AskUserQuestion {"questions":[]}' } as PermissionRequest;
    const html = renderToStaticMarkup(<PermissionCard request={q} onOpenSettings={() => undefined} />);
    expect(html).toContain(t('permission.question.unreadableNote'));
    expect(html).toContain(t('permission.question.askInChat'));
    expect(html).not.toContain(`>${t('permission.allow')}<`);
    expect(html).not.toContain(t('permission.always'));
  });
});
