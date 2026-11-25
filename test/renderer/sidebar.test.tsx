import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { Sidebar } from '../../src/renderer/Sidebar';
import { t } from '../../src/shared/strings';
import type { OrgSummary } from '../../src/shared/types';

const org = (id: string, name: string, waitingCount = 0): OrgSummary => ({ id, name, available: true, waitingCount } as OrgSummary);
const noop = (): void => undefined;
const render = (orgs: OrgSummary[], activeOrgId: string | null): string =>
  renderToStaticMarkup(<Sidebar orgs={orgs} activeOrgId={activeOrgId} onSelect={noop} onAdd={noop} onCreate={noop} onSettings={noop} onAbout={noop} onSetIcon={noop} onRemoveIcon={noop} />);
const root = path.resolve(__dirname, '../..');

describe('Sidebar: "My orgs" header', () => {
  it('is a heading, and the org list is labelled by it', () => {
    const html = render([org('a', 'ACME'), org('b', 'BOLT')], 'a');
    expect(html).toMatch(/<h2[^>]*id="sidebar-orgs-title"[^>]*>My orgs<\/h2>/);
    expect(html).toMatch(/role="list"[^>]*aria-labelledby="sidebar-orgs-title"|aria-labelledby="sidebar-orgs-title"[^>]*role="list"/);
    expect(html.match(/role="listitem"/g)).toHaveLength(3); // two orgs and the "+"
  });
  it('is shown when there is no org (Welcome), above the "+"', () => {
    const html = render([], null);
    expect(html.indexOf('My orgs')).toBeGreaterThan(-1);
    expect(html.indexOf('My orgs')).toBeLessThan(html.indexOf(t('sidebar.addOrg')));
  });
  it('keeps the rail marker on the active tile (4 px list padding + 10, 48 px per tile)', () => {
    expect(render([org('a', 'ACME'), org('b', 'BOLT')], 'b')).toContain('translateY(62px)');
    expect(render([org('a', 'ACME')], 'a')).toContain('translateY(14px)');
    expect(render([org('a', 'ACME')], null)).toContain('opacity:0');
  });
});

describe('Sidebar: app identity', () => {
  const html = render([org('a', 'ACME', 3)], 'a');
  it('is a button with the aria-label, the mark at 32 px and the name', () => {
    expect(html).toMatch(/<button[^>]*class="app-identity"[^>]*aria-label="CEO of Agents, about this app"/);
    expect(html).toMatch(/<svg[^>]*width="32"[^>]*height="32"/);
    expect(html).toContain('<span class="app-identity-name">CEO of Agents</span>');
  });
  it('sits below the divider, above Settings, after the "+" in tab order, outside the list', () => {
    expect(html.indexOf('sidebar-divider')).toBeLessThan(html.indexOf('app-identity"'));
    expect(html.indexOf('app-identity"')).toBeLessThan(html.indexOf('aria-label="Settings"'));
    expect(html.indexOf(t('sidebar.addOrg'))).toBeLessThan(html.indexOf('app-identity"'));
    expect(html.indexOf('</div></div><div class="sidebar-bottom">')).toBeGreaterThan(-1);
  });
  it('never carries a badge, the active state or a tabindex that joins the arrow group', () => {
    const block = html.slice(html.indexOf('<button class="app-identity"'), html.indexOf('</button>', html.indexOf('app-identity"')));
    expect(block).not.toContain('badge');
    expect(block).not.toContain('aria-current');
    expect(block).not.toContain('active');
    expect(block).not.toContain('rail-marker');
  });
});

describe('Sidebar: inert corner and tile size', () => {
  const disabledOf = (html: string, label: string): boolean => new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled=""`).test(html);
  it('disables the identity button and Settings when no org is open, and enables them otherwise', () => {
    const none = render([], null);
    expect(disabledOf(none, 'CEO of Agents, about this app')).toBe(true);
    expect(disabledOf(none, 'Settings')).toBe(true);
    const open = render([org('a', 'ACME')], 'a');
    expect(disabledOf(open, 'CEO of Agents, about this app')).toBe(false);
    expect(disabledOf(open, 'Settings')).toBe(false);
  });
  it('keeps the org and "+" tiles at 40 px in a scrolling list (flex: none)', () => {
    const css = fs.readFileSync(path.join(root, 'src/renderer/styles/shell.css'), 'utf8');
    expect(css).toMatch(/\.org-icon \{[^}]*flex: none;[^}]*width: 40px; height: 40px/);
  });
});

describe('Sidebar: strings and styles', () => {
  it('has the four strings of the spec', () => {
    expect(t('sidebar.myOrgs')).toBe('My orgs');
    expect(t('sidebar.appName')).toBe(t('app.title'));
    expect(t('sidebar.about')).toBe('About CEO of Agents');
    expect(t('sidebar.aboutLabel')).toBe('CEO of Agents, about this app');
  });
  it('uses tokens only in the new rail rules (no raw colours)', () => {
    const css = fs.readFileSync(path.join(root, 'src/renderer/styles/shell.css'), 'utf8');
    const rules = css.split('\n').filter((l) => /sidebar-title|sidebar-divider|app-identity/.test(l)).join('\n');
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
