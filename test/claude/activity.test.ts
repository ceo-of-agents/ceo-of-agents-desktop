import { describe, expect, it } from 'vitest';
import { describeDetail, describeTool, isAppTool } from '../../src/main/claude/activity';

const cwd = '/work/hq';
const bash = (command: string, extra: Record<string, unknown> = {}) => describeTool('Bash', { command, ...extra }, cwd);

describe('describeTool: Bash', () => {
  it('maps git commands', () => {
    expect(bash('git commit -m "x"')).toBe('Saving changes');
    expect(bash('git push origin main')).toBe('Sending to GitHub');
    expect(bash('git pull --rebase')).toBe('Getting updates from GitHub');
    expect(bash('git fetch origin')).toBe('Getting updates from GitHub');
    expect(bash('git -C /x pull')).toBe('Getting updates from GitHub');
  });
  it('maps gh to one sentence', () => {
    for (const c of ['gh issue list', 'gh pr view 3', 'gh api repos/x/y', 'gh', 'gh pr list --state merged']) expect(bash(c)).toBe('Checking GitHub');
  });

  it('says when the agent writes to GitHub', () => {
    expect(bash('gh issue create -R owner/app')).toBe('Opening an issue on GitHub');
    expect(bash('gh -R owner/app issue create --title x')).toBe('Opening an issue on GitHub');
    expect(bash('gh pr create --title x')).toBe('Opening a pull request');
    expect(bash('cd /a && gh pr merge 4 --squash')).toBe('Merging a pull request');
    expect(bash('gh issue close 12')).toBe('Closing an item on GitHub');
    expect(bash('gh pr close 12')).toBe('Closing an item on GitHub');
  });

  it('maps the test commands to "Running the tests"', () => {
    for (const c of ['npm test', 'npm run test', 'npm run check', 'cd app && npm run check', 'npm test -- --watch']) expect(bash(c)).toBe('Running the tests');
    expect(bash('npm run build')).toBe('Running a command');
    expect(bash('npm install')).toBe('Running a command');
  });
  it('everything else is a command, whatever the description says', () => {
    for (const c of ['make all', 'npm run build', 'git status', 'ls -la', '']) expect(bash(c)).toBe('Running a command');
    expect(bash('npm run build', { description: 'Build it' })).toBe('Running a command');
  });
  it('skips leading cd and env assignments', () => {
    expect(bash('cd /a/b && git pull')).toBe('Getting updates from GitHub');
    expect(bash('cd "/a b/c"; git push')).toBe('Sending to GitHub');
    expect(bash('FOO=1 BAR="x y" git commit -m x')).toBe('Saving changes');
    expect(bash('cd /a && CI=1 gh pr view')).toBe('Checking GitHub');
  });
  it('does not match a longer word', () => {
    expect(bash('ghost run')).toBe('Running a command');
    expect(bash('gitk')).toBe('Running a command');
  });
  it('handles a missing input', () => {
    expect(describeTool('Bash', undefined, cwd)).toBe('Running a command');
    expect(describeTool('Bash', 'git pull', cwd)).toBe('Running a command');
  });
});

describe('describeTool: files', () => {
  it('names the file only, never the path', () => {
    expect(describeTool('Read', { file_path: '/work/hq/company/state.md' }, cwd)).toBe('Reading state.md');
    expect(describeTool('Read', { file_path: 'company/state.md' }, cwd)).toBe('Reading state.md');
    expect(describeTool('Read', { file_path: '/other/place/x.md' }, cwd)).toBe('Reading x.md');
  });
  it('writing and editing are updating', () => {
    expect(describeTool('Write', { file_path: '/work/hq/inbox/a.md' }, cwd)).toBe('Updating a.md');
    for (const n of ['Edit', 'MultiEdit']) expect(describeTool(n, { file_path: '/work/hq/org.yaml' }, cwd)).toBe('Updating org.yaml');
    expect(describeTool('NotebookEdit', { notebook_path: '/work/hq/n.ipynb' }, cwd)).toBe('Updating n.ipynb');
  });
  it('says something plain without a path', () => {
    expect(describeTool('Read', {}, cwd)).toBe('Reading a file');
    expect(describeTool('Write', {}, cwd)).toBe('Updating a file');
    expect(describeTool('Edit', null, cwd)).toBe('Updating a file');
  });
  it('searching is one sentence', () => {
    expect(describeTool('Grep', { pattern: 'TODO' }, cwd)).toBe('Searching the hq');
    expect(describeTool('Grep', {}, cwd)).toBe('Searching the hq');
    expect(describeTool('Glob', { pattern: '**/*.md' }, cwd)).toBe('Searching the hq');
  });
});

describe('describeTool: web, tasks, helpers', () => {
  it('web', () => {
    expect(describeTool('WebFetch', { url: 'https://docs.example.com/a' }, cwd)).toBe('Looking it up online');
    expect(describeTool('WebSearch', { query: 'electron menus' }, cwd)).toBe('Looking it up online');
  });
  it('task list', () => {
    expect(describeTool('TodoWrite', { todos: [] }, cwd)).toBe('Planning the steps');
  });
  it('agents: a department is briefed, a worker is a helper', () => {
    expect(describeTool('Agent', { subagent_type: 'max' }, cwd)).toBe('Briefing Max');
    expect(describeTool('Task', { subagent_type: 'design-brand', description: 'x' }, cwd)).toBe('Briefing Design-brand');
    for (const a of ['reader', 'worker', 'general-purpose']) expect(describeTool('Agent', { subagent_type: a }, cwd)).toBe('Handing a task to a helper');
    expect(describeTool('Agent', {}, cwd)).toBe('Handing a task to a helper');
  });
  it('skills', () => {
    const map: Record<string, string> = {
      'session-start': 'Starting the session',
      intake: 'Framing your request',
      'record-decision': 'Recording the decision',
      'weekly-brief': 'Writing the brief',
      'hq-version': 'Checking the hq version',
      departments: 'Preparing the department change',
      initiatives: 'Updating the initiative',
      'product-repos': 'Checking the product repos',
    };
    for (const [k, v] of Object.entries(map)) {
      expect(describeTool('Skill', { skill: k }, cwd)).toBe(v);
      expect(describeTool('Skill', { skill: `ceo-of-agents:${k}` }, cwd)).toBe(v);
      expect(describeTool('Skill', { name: k }, cwd)).toBe(v);
    }
    expect(describeTool('Skill', { skill: 'ceo-of-agents:other-thing' }, cwd)).toBe('Working');
  });
  it('anything else is plain "Working", never a raw name', () => {
    expect(describeTool('SomethingNew', {}, cwd)).toBe('Working');
    expect(describeTool('mcp__my_server__do_it', {}, cwd)).toBe('Working');
    expect(describeTool('', undefined, cwd)).toBe('Working');
  });
});

describe('describeTool: length', () => {
  it('truncates to about 80 characters with an ellipsis', () => {
    const long = describeTool('Read', { file_path: `/x/${'a'.repeat(200)}.md` }, cwd);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });
  it('keeps short lines as they are', () => {
    expect(describeTool('Read', { file_path: '/x/a.md' }, cwd)).toBe('Reading a.md');
  });
});

describe('describeTool and describeDetail: Artifact', () => {
  const id = 'Xk3m9Qw7RtB2nLp5VdHc4a';
  const url = `https://claude.ai/artifact/${id}`;
  it('one plain line per action, with the target when there is one', () => {
    expect(describeTool('Artifact', { action: 'publish', file_path: '/abs/p.html', title: 'Weekly report' }, cwd)).toBe('Publishing the artifact Weekly report');
    expect(describeTool('Artifact', { action: 'read', url }, cwd)).toBe(`Reading artifact ${id}`);
    expect(describeTool('Artifact', { action: 'list' }, cwd)).toBe('Listing your artifacts');
    expect(describeTool('Artifact', { action: 'delete', url }, cwd)).toBe(`Deleting artifact ${id}`);
    expect(describeTool('Artifact', { action: 'open', url }, cwd)).toBe(`Opening artifact ${id}`);
    expect(describeTool('Artifact', { action: 'comments', url }, cwd)).toBe('Working on an artifact');
    expect(describeTool('Artifact', {}, cwd)).toBe('Working on an artifact');
  });
  it('keeps the 80 character cap', () => {
    const line = describeTool('Artifact', { action: 'publish', title: 'T'.repeat(300) }, cwd);
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith('…')).toBe(true);
  });
  it('detail: the action, plus the id; never the file path or content', () => {
    expect(describeDetail('Artifact', { action: 'read', url }, cwd)).toBe(`Artifact · read · ${id}`);
    expect(describeDetail('Artifact', { action: 'list' }, cwd)).toBe('Artifact · list');
    expect(describeDetail('Artifact', { action: 'publish', file_path: '/abs/secret/p.html', title: 'T', content: 'body' }, cwd)).toBe('Artifact · publish');
    expect(describeDetail('Artifact', {}, cwd)).toBe('Artifact');
  });
});

describe('describeDetail', () => {
  it('names the tool and its main argument', () => {
    expect(describeDetail('Read', { file_path: '/work/hq/company/state.md' }, cwd)).toBe('Read · company/state.md');
    expect(describeDetail('Read', { file_path: '/other/place/x.md' }, cwd)).toBe('Read · x.md');
    expect(describeDetail('Bash', { command: 'cd /work/hq && git push origin main' }, cwd)).toBe('Bash · git push');
    expect(describeDetail('Grep', { pattern: 'TODO' }, cwd)).toBe('Grep · TODO');
    expect(describeDetail('Skill', { skill: 'ceo-of-agents:intake' }, cwd)).toBe('Skill · ceo-of-agents:intake');
  });
  it('is just the tool name without an argument, and is cut at 100 characters', () => {
    expect(describeDetail('Bash', {}, cwd)).toBe('Bash');
    expect(describeDetail('mcp__x__y', { a: 1 }, cwd)).toBe('mcp__x__y');
    const long = describeDetail('Grep', { pattern: 'a'.repeat(300) }, cwd);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('isAppTool', () => {
  it("is true only for the app's permission tool", () => {
    expect(isAppTool('mcp__coa__permission_prompt')).toBe(true);
    expect(isAppTool('mcp__coa__other')).toBe(false);
    expect(isAppTool('Bash')).toBe(false);
  });
});

describe('describeDetail never stores a secret', () => {
  const secrets = ['s3cr3t', 'sk-live-abc', 'ghp_abc123', 'hunter2', 'tok', 'pw'];
  const clean = (detail: string) => {
    for (const x of secrets) expect(detail).not.toContain(x);
    return detail;
  };
  it('Bash: program and subcommand only, never arguments', () => {
    expect(clean(describeDetail('Bash', { command: 'export TOKEN=s3cr3t && npm test' }, cwd))).toBe('Bash · export');
    expect(clean(describeDetail('Bash', { command: 'TOKEN=s3cr3t npm run build' }, cwd))).toBe('Bash · npm run');
    expect(clean(describeDetail('Bash', { command: 'curl -H "Authorization: Bearer sk-live-abc" https://api.example.com/x' }, cwd))).toBe('Bash · curl');
    expect(clean(describeDetail('Bash', { command: 'gh auth login --token ghp_abc123' }, cwd))).toBe('Bash · gh auth');
    expect(clean(describeDetail('Bash', { command: 'some-cli --token ghp_abc123' }, cwd))).toBe('Bash · some-cli');
    expect(clean(describeDetail('Bash', { command: 'git clone https://user:tok@example.com/r.git' }, cwd))).toBe('Bash · git clone');
    expect(clean(describeDetail('Bash', { command: 'psql postgres://u:pw@db.example.com/app' }, cwd))).toBe('Bash · psql');
    expect(clean(describeDetail('Bash', { command: 'echo hunter2' }, cwd))).toBe('Bash · echo');
    expect(clean(describeDetail('Bash', { command: 'https://user:tok@example.com' }, cwd))).toBe('Bash');
    expect(describeDetail('Bash', { command: 'git -C /work/hq push origin main' }, cwd)).toBe('Bash · git push');
    expect(describeDetail('Bash', { command: '/usr/local/bin/gh pr create --title x' }, cwd)).toBe('Bash · gh pr');
  });
  it('WebFetch: the host only', () => {
    expect(clean(describeDetail('WebFetch', { url: 'https://user:pw@example.com/path?token=s3cr3t' }, cwd))).toBe('WebFetch · example.com');
    expect(describeDetail('WebFetch', { url: 'not a url' }, cwd)).toBe('WebFetch');
  });
  it('WebSearch: the query, cut at 60 characters', () => {
    expect(describeDetail('WebSearch', { query: 'electron offscreen capture' }, cwd)).toBe('WebSearch · electron offscreen capture');
    const long = describeDetail('WebSearch', { query: 'q'.repeat(200) }, cwd);
    expect(long).toBe(`WebSearch · ${'q'.repeat(59)}…`);
  });
});
