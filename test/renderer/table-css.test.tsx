import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/renderer/Markdown';
import { WHOLE_CELL_MAX, keepCellWhole } from '../../src/renderer/table-cells';

const css = readFileSync(join(__dirname, '../../src/renderer/styles/thread.css'), 'utf8');

/** The declarations of the rule with exactly this selector list (comments removed). */
const ruleBody = (selector: string): string => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(plain);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
};

describe('chat table cells', () => {
  it('.msg breaks anywhere, so table cells must opt out', () => {
    expect(ruleBody('.msg')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ruleBody('.md th, .md td')).toMatch(/overflow-wrap:\s*normal/);
  });
  it('a table wider than the thread scrolls sideways', () => {
    expect(ruleBody('.md table')).toMatch(/overflow-x:\s*auto/);
  });
});

describe('short one-word cells stay on one line', () => {
  it('keepCellWhole: one word up to the limit', () => {
    for (const t of ['ACME-A12', '2026-01-05', 'feat/welcome-screen', ' normal ', 'x'.repeat(WHOLE_CELL_MAX)]) expect(keepCellWhole(t), t).toBe(true);
    for (const t of ['', '   ', 'in review', 'x'.repeat(WHOLE_CELL_MAX + 1), 'Merge the welcome screen']) expect(keepCellWhole(t), t).toBe(false);
  });
  it('the Markdown table marks those cells, keeps alignment, and the CSS keeps them whole', () => {
    const out = renderToStaticMarkup(<Markdown text={'| Code | Description |\n|:--|--:|\n| **ACME-A12** | Merge the welcome screen pull request |'} />);
    expect(out).toMatch(/<td[^>]*class="nowrap"[^>]*><strong>ACME-A12<\/strong><\/td>/);
    expect(out).toMatch(/<th[^>]*class="nowrap"[^>]*>Code<\/th>/);
    expect(out).toMatch(/<td(?![^>]*nowrap)[^>]*>Merge the welcome screen pull request<\/td>/);
    expect(out).toMatch(/text-align:\s*right/);
    expect(ruleBody('.md th.nowrap, .md td.nowrap')).toMatch(/white-space:\s*nowrap/);
  });
});
