import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isForbiddenServer, matchesPattern, mcpServerNames, mcpToolEntries, readConnectors } from '../../src/main/hq/connectors';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-connectors-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function hq(orgYaml: string, agents: Record<string, string> = {}, mcp?: string): string {
  fs.writeFileSync(path.join(root, 'org.yaml'), orgYaml);
  if (Object.keys(agents).length) fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(agents)) fs.writeFileSync(path.join(root, '.claude', 'agents', `${name}.md`), text);
  if (mcp !== undefined) fs.writeFileSync(path.join(root, '.mcp.json'), mcp);
  return root;
}

const agentFile = (tools: string): string => `---\nname: max\ntools: ${tools}\n---\nBody.\n`;

const ORG = `
departments:
  - id: engineering
    agent: max
    from_catalog: engineering
    display_name: Max
    connectors: ['mcp__tracker__*', 'mcp__notes__search']
  - id: legal
    agent: lena
    from_catalog: legal
    display_name: Lena
    connectors: []
  - id: ops
    agent: ops
accounts:
  forbidden_connectors: ['mcp__mail__*']
`;

describe('matchesPattern', () => {
  it('matches exact names and globs', () => {
    expect(matchesPattern('mcp__mail__*', 'mcp__mail__*')).toBe(true);
    expect(matchesPattern('mcp__mail__*', 'mcp__mail__send')).toBe(true);
    expect(matchesPattern('mcp__mail__*', 'mcp__notes__*')).toBe(false);
    expect(matchesPattern('mcp__*', 'mcp__notes__*')).toBe(true);
    expect(matchesPattern('*mail*', 'mcp__mail__*')).toBe(true);
    expect(matchesPattern('*', '')).toBe(true);
    expect(matchesPattern('', '')).toBe(true);
    expect(matchesPattern('', 'a')).toBe(false);
    expect(matchesPattern('a*b*c', 'axxbyyc')).toBe(true);
    expect(matchesPattern('a*b*c', 'axxbyy')).toBe(false);
  });
  it('treats regex characters literally and does not blow up on many stars', () => {
    expect(matchesPattern('a.b', 'axb')).toBe(false);
    expect(matchesPattern('a.b', 'a.b')).toBe(true);
    const t0 = Date.now();
    expect(matchesPattern('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('a forbidden tool of a server rules out offering the whole server', () => {
    expect(isForbiddenServer(['mcp__mail__send'], 'mail')).toBe(true);
    expect(isForbiddenServer(['mcp__mail__send'], 'notes')).toBe(false);
    expect(isForbiddenServer(['mcp__*'], 'notes')).toBe(true);
  });
  it('a bare server entry and wildcard forms forbid the whole server', () => {
    expect(isForbiddenServer(['mcp__notes'], 'notes')).toBe(true);
    expect(isForbiddenServer(['mcp__notes'], 'notes2')).toBe(false);
    expect(isForbiddenServer(['mcp__notes'], 'note')).toBe(false);
    expect(isForbiddenServer(['mcp__notes*'], 'notes')).toBe(true);
    expect(isForbiddenServer(['mcp__no*'], 'notes')).toBe(true);
    expect(isForbiddenServer(['mcp__no*'], 'mail')).toBe(false);
    expect(isForbiddenServer(['*'], 'notes')).toBe(true);
    expect(isForbiddenServer(['mcp__notes__*'], 'notes')).toBe(true);
    expect(isForbiddenServer(['mcp__other'], 'notes')).toBe(false);
  });
});

describe('mcpToolEntries', () => {
  it('reads a comma string and a list, keeps only mcp__ entries, ignores commas inside parentheses', () => {
    expect(mcpToolEntries('Read, Agent(a, mcp__x__y), mcp__tracker__*, mcp__tracker__*')).toEqual(['mcp__tracker__*']);
    expect(mcpToolEntries(['Read', 'mcp__notes__search', ' mcp__files__* '])).toEqual(['mcp__notes__search', 'mcp__files__*']);
    expect(mcpToolEntries(undefined)).toEqual([]);
  });
});

describe('readConnectors', () => {
  it('reads grants, agent file entries, the advisory flag and the forbidden list, in org.yaml order', () => {
    const dir = hq(ORG, { max: agentFile('Read, Edit, mcp__tracker__*'), lena: agentFile('Read') });
    const c = readConnectors(dir);
    expect(c.error).toBeNull();
    expect(c.departments.map((d) => d.id)).toEqual(['engineering', 'legal', 'ops']);
    expect(c.departments[0]).toEqual({ id: 'engineering', displayName: 'Max', agent: 'max', advisory: false, granted: ['mcp__tracker__*', 'mcp__notes__search'], inAgentFile: ['mcp__tracker__*'], mcpLock: null });
    expect(c.departments[1]).toMatchObject({ advisory: true, granted: [], inAgentFile: [], mcpLock: null });
    expect(c.departments[2]).toMatchObject({ displayName: 'ops', agent: 'ops', advisory: false, granted: [], inAgentFile: [], mcpLock: 'no-tools-line' });
    expect(c.forbidden).toEqual(['mcp__mail__*']);
  });
  it('shows a mismatch both ways: in the agent file only, in org.yaml only', () => {
    const c = readConnectors(hq(ORG, { max: agentFile('mcp__files__*, mcp__tracker__*') }));
    const max = c.departments[0];
    expect(max.inAgentFile).toEqual(['mcp__files__*', 'mcp__tracker__*']);
    expect(max.granted.filter((g) => !max.inAgentFile.includes(g))).toEqual(['mcp__notes__search']);
    expect(max.inAgentFile.filter((g) => !max.granted.includes(g))).toEqual(['mcp__files__*']);
  });
  it('flags legal, finance and tax as advisory', () => {
    const c = readConnectors(hq('departments:\n  - {id: a, from_catalog: finance}\n  - {id: b, from_catalog: tax}\n  - {id: c, from_catalog: own}\n'));
    expect(c.departments.map((d) => d.advisory)).toEqual([true, true, false]);
  });
  it('a tools list in the agent file works too', () => {
    const c = readConnectors(hq(ORG, { max: '---\nname: max\ntools:\n  - Read\n  - mcp__calendar__*\n---\n' }));
    expect(c.departments[0].inAgentFile).toEqual(['mcp__calendar__*']);
  });
  it('mcpLock is no-tools-line for no tools line, an empty one, an empty list, no agent file or one too big to read, else null', () => {
    const only = (agents: Record<string, string>) => {
      fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
      return readConnectors(hq('departments:\n  - {id: engineering, agent: max}\n', agents)).departments[0].mcpLock;
    };
    expect(only({ max: agentFile('Read') })).toBeNull();
    expect(only({ max: agentFile('mcp__tracker__*') })).toBeNull();
    expect(only({ max: '---\nname: max\ntools:\n  - Read\n---\n' })).toBeNull();
    expect(only({ max: '---\nname: max\ndescription: x\n---\nBody.\n' })).toBe('no-tools-line');
    expect(only({ max: '---\nname: max\ntools:\n---\n' })).toBe('no-tools-line');
    expect(only({ max: '---\nname: max\ntools: ""\n---\n' })).toBe('no-tools-line');
    expect(only({ max: '---\nname: max\ntools: []\n---\n' })).toBe('no-tools-line');
    expect(only({})).toBe('no-tools-line');
    expect(only({ max: `${agentFile('Read')}${'x'.repeat(300 * 1024)}` })).toBe('no-tools-line');
  });
  it('a * entry in the tools line (alone, quoted, in a list, or after another tool) gives every tool: all-tools; mcp__x__* is not a star', () => {
    const only = (agents: Record<string, string>) => {
      fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
      return readConnectors(hq('departments:\n  - {id: engineering, agent: max}\n', agents)).departments[0];
    };
    expect(only({ max: '---\nname: max\ntools: "*"\n---\n' }).mcpLock).toBe('all-tools');
    expect(only({ max: '---\nname: max\ntools: ["*"]\n---\n' }).mcpLock).toBe('all-tools');
    expect(only({ max: '---\nname: max\ntools:\n  - Read\n  - "*"\n---\n' }).mcpLock).toBe('all-tools');
    expect(only({ max: '---\nname: max\ntools: Read, *\n---\n' }).mcpLock).toBe('all-tools');
    expect(only({ max: '---\nname: max\ntools: Read,*\n---\n' }).mcpLock).toBe('all-tools');
    expect(only({ max: '---\nname: max\ntools: mcp__x__*\n---\n' })).toMatchObject({ mcpLock: null, inAgentFile: ['mcp__x__*'] });
    expect(only({ max: '---\nname: max\ntools: Read, Bash(git *)\n---\n' }).mcpLock).toBeNull();
  });
  it('the agent file is the one whose frontmatter name is the agent, else the one called after it', () => {
    const only = (agents: Record<string, string>) => {
      fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
      return readConnectors(hq('departments:\n  - {id: engineering, agent: max}\n', agents)).departments[0];
    };
    // file name and name disagree: Claude Code loads the file named `max` (no tools line), not max.md
    const d = only({ max: '---\nname: other\ntools: Read, mcp__a__*\n---\n', 'renamed': '---\nname: max\ndescription: x\n---\n' });
    expect(d.mcpLock).toBe('no-tools-line');
    expect(only({ max: '---\nname: other\ntools: Read, mcp__a__*\n---\n' })).toMatchObject({ mcpLock: null, inAgentFile: ['mcp__a__*'] });
    expect(only({ 'renamed': '---\nname: max\ntools: Read, mcp__b__*\n---\n' })).toMatchObject({ mcpLock: null, inAgentFile: ['mcp__b__*'] });
  });
  it('offers the servers of .mcp.json by name, minus the forbidden ones (glob), skipping invalid names', () => {
    const mcp = JSON.stringify({ mcpServers: { notes: { command: 'x' }, mail: { command: 'y' }, tracker: {}, 'bad name': {}, 'a/b': {}, 'cal.endar-2_x': {} } });
    const c = readConnectors(hq(ORG, {}, mcp));
    expect(c.available).toEqual([
      { server: 'notes', pattern: 'mcp__notes__*' },
      { server: 'tracker', pattern: 'mcp__tracker__*' },
    ]);
    expect(c.notGrantable).toEqual(['cal.endar-2_x']); // a dot in the name: not grantable, shown with a note
    const all = readConnectors(hq(ORG.replace("'mcp__mail__*'", "'mcp__*'"), {}, mcp));
    expect(all.available).toEqual([]);
  });
  it('a bare or wildcard forbidden entry keeps the server out of the offered list', () => {
    const mcp = JSON.stringify({ mcpServers: { notes: {}, mail: {}, tracker: {} } });
    for (const entry of ['mcp__notes', 'mcp__notes*', 'mcp__no*']) {
      const c = readConnectors(hq(ORG.replace("'mcp__mail__*'", `'${entry}'`), {}, mcp));
      expect(c.available.map((a) => a.server)).toEqual(['mail', 'tracker']);
    }
  });
  it('never puts a value of .mcp.json in the result (secrets in env, args, headers)', () => {
    const secret = 'sk-test-SECRET-0123456789';
    const mcp = JSON.stringify({ mcpServers: { files: { command: '/usr/bin/files-server', args: ['--token', secret], env: { API_KEY: secret }, headers: { Authorization: `Bearer ${secret}` } } } });
    const c = readConnectors(hq(ORG, {}, mcp));
    const json = JSON.stringify(c);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('files-server');
    expect(json).not.toContain('API_KEY');
    expect(c.available).toEqual([{ server: 'files', pattern: 'mcp__files__*' }]);
  });
  it('no .mcp.json, a broken one or one without servers: nothing offered', () => {
    expect(readConnectors(hq(ORG)).available).toEqual([]);
    expect(readConnectors(hq(ORG, {}, '{ not json')).available).toEqual([]);
    expect(readConnectors(hq(ORG, {}, '{"mcpServers": []}')).available).toEqual([]);
    expect(readConnectors(hq(ORG, {}, '[]')).available).toEqual([]);
  });
  it('a regular .mcp.json works; a symlink (outside or inside the hq) or a folder named .mcp.json gives no servers', () => {
    const mcp = JSON.stringify({ mcpServers: { notes: {} } });
    expect(readConnectors(hq(ORG, {}, mcp)).available).toEqual([{ server: 'notes', pattern: 'mcp__notes__*' }]);
    fs.rmSync(path.join(root, '.mcp.json'));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-connectors-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'real.json'), mcp);
      fs.symlinkSync(path.join(outside, 'real.json'), path.join(root, '.mcp.json'));
      const out = readConnectors(root);
      expect(out.error).toBeNull();
      expect(out.available).toEqual([]);
      fs.rmSync(path.join(root, '.mcp.json'));

      fs.writeFileSync(path.join(root, 'inside.json'), mcp);
      fs.symlinkSync(path.join(root, 'inside.json'), path.join(root, '.mcp.json'));
      expect(readConnectors(root).available).toEqual([]);
      fs.rmSync(path.join(root, '.mcp.json'));

      fs.mkdirSync(path.join(root, '.mcp.json'));
      fs.writeFileSync(path.join(root, '.mcp.json', 'x'), mcp);
      expect(readConnectors(root).available).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('a missing org.yaml gives an error and empty lists, without throwing', () => {
    const c = readConnectors(root);
    expect(c.error).toMatch(/not found/);
    expect(c).toMatchObject({ departments: [], forbidden: [], available: [], notGrantable: [] });
    expect(readConnectors(path.join(root, 'nope')).error).toBeTruthy();
  });
  it('an unreadable org.yaml (a folder, invalid YAML, a list, empty) gives an error', () => {
    fs.mkdirSync(path.join(root, 'org.yaml'));
    expect(readConnectors(root).error).toBeTruthy();
    fs.rmdirSync(path.join(root, 'org.yaml'));
    expect(readConnectors(hq('departments: [unclosed\n  - x: : y\n')).error).toBeTruthy();
    expect(readConnectors(hq('- a\n- b\n')).error).toBeTruthy();
    expect(readConnectors(hq('   \n')).error).toBeTruthy();
    expect(readConnectors(hq('departments: [unclosed')).departments).toEqual([]);
  });
  it('a file over 256 KB is not read: org.yaml is an error, an agent file or .mcp.json counts as empty', () => {
    expect(readConnectors(hq(`${ORG}\n# ${'x'.repeat(300 * 1024)}\n`)).error).toMatch(/256 KB/);
    const big = `${agentFile('mcp__tracker__*')}${'x'.repeat(300 * 1024)}`;
    const mcp = JSON.stringify({ mcpServers: { notes: {} }, pad: 'x'.repeat(300 * 1024) });
    const c = readConnectors(hq(ORG, { max: big }, mcp));
    expect(c.error).toBeNull();
    expect(c.departments[0].inAgentFile).toEqual([]);
    expect(c.available).toEqual([]);
  });
  it('an agent name that is a path is never joined to the agents folder', () => {
    fs.writeFileSync(path.join(root, 'secret.md'), agentFile('mcp__leak__*'));
    const c = readConnectors(hq('departments:\n  - {id: x, agent: ../secret}\n'));
    expect(c.departments[0].inAgentFile).toEqual([]);
  });
  it('ids that look like inherited properties are plain data', () => {
    const c = readConnectors(hq('departments:\n  - {id: constructor, connectors: [mcp__notes__*]}\n  - {id: __proto__}\n'));
    expect(c.departments.map((d) => d.id)).toEqual(['constructor', '__proto__']);
    expect(structuredClone(c).departments[0].granted).toEqual(['mcp__notes__*']);
  });
});

describe('mcpServerNames', () => {
  it('returns names only', () => {
    expect(mcpServerNames('{"mcpServers":{"notes":{"env":{"K":"v"}}}}')).toEqual(['notes']);
  });
});

describe('the module has no write path', () => {
  it('imports no write function and never reads user-scope state', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/main/hq/connectors.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/writeFile|appendFile|rename|unlink|rmSync|mkdir|copyFile|createWriteStream|child_process|spawn|exec/);
    expect(src).not.toMatch(/\.claude\.json|homedir|claude mcp/);
  });
});
