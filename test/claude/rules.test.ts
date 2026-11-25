import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorPathRule, filterAllowRules, isDenied, parseBash, readDenyRules, readHqPermissionRules, ruleFor, validateRule } from '../../src/main/claude/rules';

const HQ = '/tmp/hq';
const bash = (command: string) => ({ command });

describe('ruleFor (Bash)', () => {
  const r = (c: string) => ruleFor('Bash', bash(c), HQ);
  it('proposes a prefix in the space-star form, never the full command', () => {
    expect(r('gh issue list -R x/y --limit 30')).toBe('Bash(gh issue list *)');
    expect(r('git commit -m "a && b"')).toBe('Bash(git commit *)');
    expect(r('git status')).toBe('Bash(git status *)');
    expect(r('npm run build -- --watch')).toBe('Bash(npm run build *)');
    expect(r('npm install left-pad')).toBe('Bash(npm install *)');
    expect(r('brew list')).toBe('Bash(brew list *)');
      });
  it('skips a leading cd', () => {
    expect(r('cd /hq && git pull -q')).toBe('Bash(git pull *)');
  });
  it('proposes the exact command for programs that run other programs', () => {
    for (const c of ['rm -rf x', 'find . -name a', 'sed s/a/b/ f', 'curl https://example.com', 'docker ps -a', 'node x.js', 'python3.12 x.py', 'env', 'xargs echo', 'npx vitest run', 'timeout 5 ls']) {
      expect(r(c), c).toBe(`Bash(${c})`);
    }
  });
  it('proposes the exact command for gh api, git -c and git config', () => {
    expect(r('gh api repos/x/y')).toBe('Bash(gh api repos/x/y)');
    expect(r('git -c core.pager=sh log')).toBe('Bash(git -c core.pager=sh log)');
    expect(r('git config user.name x')).toBe('Bash(git config user.name x)');
    expect(r('git -C /hq log')).toBe('Bash(git -C /hq log)');
  });
  it('proposes nothing for a line that is too clever or too long', () => {
    const none = [
      'ls\nls',
      'echo $(date)',
      'echo `date`',
      "echo $'a'",
      'ls > out',
      'cat < in',
      '(ls)',
      'git diff a\\b',
      'GIT_EXTERNAL_DIFF=x git diff',
      'ls ' + 'a'.repeat(200),
      './run.sh',
      '/tmp/evil/ls',
      '/usr/bin/git status',
      '',
    ];
    for (const c of none) expect(r(c), c).toBe('');
  });
  it('proposes nothing for an exact command that holds a wildcard', () => {
    expect(r('rm *.tmp')).toBe('');
  });
});

describe('ruleFor (other tools)', () => {
  it('skill, web and mcp tools', () => {
    expect(ruleFor('Skill', { skill: 'a:b' }, HQ)).toBe('Skill(a:b)');
    expect(ruleFor('WebFetch', { url: 'https://example.com/a' }, HQ)).toBe('WebFetch(domain:example.com)');
    expect(ruleFor('WebSearch', {}, HQ)).toBe('WebSearch');
    expect(ruleFor('mcp__coa__x', {}, HQ)).toBe('mcp__coa__x');
  });
  it('read tools get no bare-name proposal', () => {
    for (const n of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) expect(ruleFor(n, {}, HQ), n).toBe('');
  });
  it('edit tools: the exact file, never a glob', () => {
    expect(ruleFor('Edit', { file_path: '/tmp/hq/company/state.md' }, HQ)).toBe('Edit(/company/state.md)');
    expect(ruleFor('Write', { file_path: 'org.yaml' }, HQ)).toBe('Edit(/org.yaml)');
    expect(ruleFor('Write', { file_path: '/elsewhere/x.md' }, HQ)).toBe('Edit(//elsewhere/x.md)');
    expect(ruleFor('Edit', {}, HQ)).toBe('');
  });
  it('edit tools: nothing under .claude or .git, nor for a glob in the name', () => {
    for (const f of ['/tmp/hq/.claude/settings.json', '/tmp/hq/.git/config', '/tmp/hq/a/.Claude/x', '/other/.git/hooks/pre-commit', '/tmp/hq/a*.md', '/tmp/hq/[x].md']) {
      expect(ruleFor('Write', { file_path: f }, HQ), f).toBe('');
    }
  });
});

describe('ruleFor (Artifact)', () => {
  const r = (input: unknown) => ruleFor('Artifact', input, HQ);
  it('proposes a scoped rule for read, list and open only', () => {
    expect(r({ action: 'read', url: 'https://claude.ai/artifact/Xk3m9Qw7RtB2nLp5VdHc4a' })).toBe('Artifact(action:read)');
    expect(r({ action: 'list' })).toBe('Artifact(action:list)');
    expect(r({ action: 'open', url: 'https://claude.ai/artifact/Xk3m9Qw7RtB2nLp5VdHc4a' })).toBe('Artifact(action:open)');
  });
  it('proposes nothing for publish, delete, pin, share or an unknown action', () => {
    for (const action of ['publish', 'delete', 'pin', 'unpin', 'share', 'write_db', 'run_script', 'nope']) expect(r({ action }), action).toBe('');
    expect(r({})).toBe('');
    expect(r(undefined)).toBe('');
    expect(r({ action: ['read'] })).toBe('');
  });
});

describe('validateRule', () => {
  it('accepts what a proposal could be', () => {
    for (const ok of ['Bash(git log *)', 'Bash(git log:*)', 'Bash(npm test)', 'Bash(rm x)', 'Bash(gh api repos/x/y)', 'Bash(make test)']) {
      expect(validateRule(ok, 'Bash'), ok).toBe(true);
    }
    expect(validateRule('Edit(/inbox/n.md)', 'Write', HQ)).toBe(true);
    expect(validateRule('Write(//elsewhere/x.md)', 'Edit', HQ)).toBe(true);
    expect(validateRule('Edit(notes.md)', 'Edit', HQ)).toBe(true);
    expect(validateRule('WebFetch(domain:example.com)', 'WebFetch')).toBe(true);
    expect(validateRule('Skill(a:b)', 'Skill')).toBe(true);
    expect(validateRule('mcp__coa__x', 'mcp__coa__x')).toBe(true);
  });
  it('rejects broad, dangerous, multi-line and odd Bash rules', () => {
    const bad = [
      '', '   ', 'Bash(a)\nBash(b)', 'Bash', 'Bash(*)', 'Bash(:*)', 'Bash( *)', 'Bash()', 'Bash(**)', 'Bash(a',
      'Bash(bash *)', 'Bash(sh:*)', 'Bash(python3.12 *)', 'Bash(env *)', 'Bash(sudo *)', 'Bash(rm *)', 'Bash(find *)', 'Bash(xargs *)',
      'Bash(git *)', 'Bash(gh *)', 'Bash(gh api *)', 'Bash(git config *)', 'Bash(git -c *)', 'Bash(* push)', 'Bash(g*t log)',
      'Bash(./run *)', 'Bash(/bin/ls *)', 'Bash(FOO=1 git diff *)', 'Bash(echo $(x) *)', 'Bash(ls > x)', 'Bash(ls ' + 'a'.repeat(210) + ')',
    ];
    for (const b of bad) expect(validateRule(b, 'Bash'), b).toBe(false);
  });
  it('Artifact: only the three exact safe rules', () => {
    for (const ok of ['Artifact(action:read)', 'Artifact(action:list)', ' Artifact(action:open) ']) expect(validateRule(ok, 'Artifact'), ok).toBe(true);
    const bad = ['Artifact', 'Artifact(action:delete)', 'Artifact(action:publish)', 'Artifact(action:*)', 'Artifact(*)', 'Artifact(read)', 'Artifact(action:read*)', 'Artifact(url:read)', 'Artifact(action:read, action:delete)', 'Artifact()', 'Bash(ls)'];
    for (const b of bad) expect(validateRule(b, 'Artifact'), b).toBe(false);
    expect(validateRule('Artifact(action:read)', 'Bash')).toBe(false);
  });
  it('rejects rules for another tool', () => {
    expect(validateRule('Bash(ls)', 'Read')).toBe(false);
    expect(validateRule(undefined, 'Bash')).toBe(false);
    expect(validateRule('Bash(ls *)', 'Edit')).toBe(false);
    expect(validateRule('Skill(x)', 'Bash')).toBe(false);
    expect(validateRule('Edit(a)', 'Bash')).toBe(false);
    expect(validateRule('Read', 'Read')).toBe(false);
  });
  it('rejects broad, glob, dot-folder and directory Edit rules', () => {
    const bad = [
      'Edit', 'Edit(**)', 'Edit(/**)', 'Edit(//**)', 'Edit(/inbox/**)', 'Edit(*.md)', 'Edit(/a?.md)', 'Edit(/)', 'Edit(.)',
      'Edit(/.claude/settings.json)', 'Edit(.git/config)', 'Edit(//x/.Claude/y)', 'Edit(/a/.git/b)', 'Edit(/../x)', 'Edit(~/x.md)',
      'Edit(/inbox/)', 'Edit(/.claude)',
    ];
    for (const b of bad) expect(validateRule(b, 'Edit', HQ), b).toBe(false);
  });
  it('rejects an Edit rule for an existing directory', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-val-'));
    fs.mkdirSync(path.join(d, 'company'));
    fs.writeFileSync(path.join(d, 'a.md'), '');
    try {
      expect(validateRule('Edit(/company)', 'Edit', d)).toBe(false);
      expect(validateRule('Edit(/a.md)', 'Edit', d)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('parseBash', () => {
  it('splits outside quotes only', () => {
    expect(parseBash('a && b || c; d | e').parts).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parseBash('echo "a && b" ; ls').parts).toEqual(['echo "a && b"', 'ls']);
    expect(parseBash("echo 'a | b'").parts).toEqual(["echo 'a | b'"]);
  });
});

describe('anchorPathRule', () => {
  const hq = '/Users/x/my hq';
  it('rewrites a single-slash path rule into the absolute form', () => {
    expect(anchorPathRule('Edit(/**)', hq)).toBe('Edit(//Users/x/my hq/**)');
    expect(anchorPathRule('Read(/company/**)', hq)).toBe('Read(//Users/x/my hq/company/**)');
    for (const t of ['Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']) expect(anchorPathRule(`${t}(/a)`, hq)).toBe(`${t}(//Users/x/my hq/a)`);
  });
  it('leaves everything else alone', () => {
    for (const r of ['Edit(//abs/**)', 'Read(~/.ssh/**)', 'Edit(inbox/**)', 'Edit(./a)', 'Edit', 'Bash(/bin/ls *)', 'Skill(ceo-of-agents:*)', 'WebFetch(domain:x.com)', 'Not a rule']) {
      expect(anchorPathRule(r, hq), r).toBe(r);
    }
  });
});

describe('isDenied', () => {
  it('deny rules hit one part of a line, also through a path or an env prefix', () => {
    expect(isDenied(['Bash(git push:*)'], 'Bash', bash('ls && git push origin x'), HQ)).toBe('Bash(git push:*)');
    expect(isDenied(['Bash(git push *)'], 'Bash', bash('GIT_X=1 /usr/bin/git push'), HQ)).toBe('Bash(git push *)');
    expect(isDenied(['Edit(.env)'], 'Write', { file_path: '.env' }, HQ)).toBe('Edit(.env)');
    expect(isDenied(['Read(./.env)'], 'Read', { file_path: '/tmp/hq/.env' }, HQ)).toBe('Read(./.env)');
    expect(isDenied(['Read(//etc/**)'], 'Read', { file_path: '/etc/hosts' }, HQ)).toBe('Read(//etc/**)');
    expect(isDenied(['Read(~/.ssh/**)'], 'Read', { file_path: path.join(os.homedir(), '.ssh', 'id') }, HQ)).toBe('Read(~/.ssh/**)');
    expect(isDenied(['mcp__x'], 'mcp__x__y', {}, HQ)).toBe('mcp__x');
    expect(isDenied(['Bash(rm:*)'], 'Bash', bash('ls'), HQ)).toBeNull();
    expect(isDenied(['Bash(git push:*)'], 'Bash', bash('git pushx'), HQ)).toBeNull();
  });
  it('Artifact(action:x) matches that action only; a bare Artifact rule matches every call', () => {
    expect(isDenied(['Artifact(action:delete)'], 'Artifact', { action: 'delete', url: 'https://claude.ai/artifact/Xk3m9Qw7RtB2nLp5VdHc4a' }, HQ)).toBe('Artifact(action:delete)');
    expect(isDenied(['Artifact(action:delete)'], 'Artifact', { action: 'read' }, HQ)).toBeNull();
    expect(isDenied(['Artifact(action:delete)'], 'Artifact', {}, HQ)).toBeNull();
    expect(isDenied(['Artifact(action:delete)'], 'Bash', { command: 'ls' }, HQ)).toBeNull();
    expect(isDenied(['Artifact(url:x)'], 'Artifact', { action: 'delete' }, HQ)).toBeNull();
    expect(isDenied(['Artifact(action:pub*)'], 'Artifact', { action: 'publish' }, HQ)).toBe('Artifact(action:pub*)');
    // spaces after `action:` do not change the rule
    expect(isDenied(['Artifact(action: delete)'], 'Artifact', { action: 'delete' }, HQ)).toBe('Artifact(action: delete)');
    expect(isDenied(['Artifact(action:  pub* )'], 'Artifact', { action: 'publish' }, HQ)).toBe('Artifact(action:  pub* )');
    expect(isDenied(['Artifact(action: delete)'], 'Artifact', { action: 'read' }, HQ)).toBeNull();
    expect(isDenied(['Artifact'], 'Artifact', { action: 'list' }, HQ)).toBe('Artifact');
  });
});

describe('exact-only programs and git subcommands', () => {
  const r = (c: string) => ruleFor('Bash', bash(c), HQ);
  it('proposes the exact command, never a prefix', () => {
    for (const c of ['npm exec foo', 'npm x foo', 'pnpm install', 'yarn add x', 'cargo build', 'go test ./...', 'make test', 'swift build', 'security find-generic-password -s x', 'launchctl list', 'defaults read x', 'tee out.txt', 'dd if=a of=b', 'tar xf a.tar', 'cp a b', 'mv a b', 'chmod +x a', 'git push origin main', 'git reset --hard', 'git clean -fd', 'git checkout main', 'git branch -D x', 'git remote add o u']) {
      expect(r(c), c).toBe(`Bash(${c})`);
      expect(validateRule(`Bash(${c} *)`, 'Bash', HQ), c).toBe(false);
      expect(validateRule(`Bash(${c})`, 'Bash', HQ), c).toBe(true);
    }
  });
  it('cat, head, tail, rg, grep: a prefix only when every path stays in the hq', () => {
    expect(r('cat notes.md')).toBe('Bash(cat *)');
    expect(r('rg foo src/a')).toBe('Bash(rg *)');
    for (const c of ['cat /etc/hosts', 'head -n 3 ../x', 'tail /tmp/hq2/x', 'grep -r a ~/dir', 'rg a /Users/x/y']) {
      expect(r(c), c).toBe(`Bash(${c})`);
    }
    expect(r('cat /tmp/hq/a.md')).toBe('Bash(cat *)');
    expect(validateRule('Bash(cat /etc/hosts *)', 'Bash', HQ)).toBe(false);
    expect(validateRule('Bash(cat /etc/hosts)', 'Bash', HQ)).toBe(true);
  });
});

describe('no proposal for sensitive paths', () => {
  it('dotfiles outside the hq, and .mcp.json, CLAUDE.md, AGENTS.md anywhere', () => {
    for (const f of ['/home/u/.zshrc', '/home/u/.config/x/y', '/tmp/hq/../.env', '/tmp/hq/.mcp.json', '/tmp/hq/CLAUDE.md', '/tmp/hq/sub/AGENTS.md', '/other/claude.md', '/other/.mcp.json']) {
      expect(ruleFor('Edit', { file_path: f }, HQ), f).toBe('');
    }
    for (const b of ['Edit(//home/u/.zshrc)', 'Edit(//home/u/.config/a)', 'Edit(/CLAUDE.md)', 'Edit(/sub/AGENTS.md)', 'Edit(//x/.mcp.json)', 'Edit(.mcp.json)']) {
      expect(validateRule(b, 'Edit', HQ), b).toBe(false);
    }
  });
  it('Bash commands that name them get no proposal', () => {
    for (const c of ['cp a ~/.zshrc', 'echo x CLAUDE.md', 'touch /home/u/.ssh/config', 'ls .mcp.json']) {
      expect(ruleFor('Bash', bash(c), HQ), c).toBe('');
    }
    expect(validateRule('Bash(cp a ~/.zshrc)', 'Bash', HQ)).toBe(false);
  });
});

describe('filterAllowRules: Artifact', () => {
  it('keeps the three safe rules and drops every other Artifact rule', () => {
    const safe = ['Artifact(action:read)', 'Artifact(action:list)', 'Artifact(action:open)'];
    const other = ['Artifact', 'Artifact(action:delete)', 'Artifact(action:publish)', 'Artifact(action:*)', 'Artifact(read)', 'Artifact(*)'];
    expect(filterAllowRules([...safe, ...other], '/tmp/hq')).toEqual({ kept: safe, dropped: other });
  });
});

describe('filterAllowRules', () => {
  const hq = '/tmp/hq';
  const planGood = [
    'Skill(ceo-of-agents:*)', 'Skill(my-skill)', 'Edit(/**)', 'Edit(/inbox/**)', 'Read(~/.claude/plugins/cache/ceo-of-agents/**)',
    'Read(//tmp/hq/notes/**)', 'WebFetch(domain:example.com)',
    ...['issue list', 'issue view', 'pr list', 'pr view', 'pr diff', 'pr checks', 'repo view', 'release list', 'release view', 'run list', 'run view', 'label list', 'search issues', 'search prs', 'project view', 'project item-list', 'project field-list', 'auth status'].map((c) => `Bash(gh ${c} *)`),
    'Bash(git pull)', 'Bash(git pull --ff-only)', 'Bash(git fetch)', 'Bash(git fetch origin)', 'Bash(git fetch --prune)', 'Bash(git remote)', 'Bash(git remote -v)', 'Bash(git rev-list *)', 'Bash(date +%F)',
    'Bash(git add *)', 'Bash(git commit *)',
    ...['issue create', 'issue edit', 'issue close', 'issue reopen', 'label create', 'label edit', 'issue comment', 'pr comment', 'pr create'].flatMap((c) => [`Bash(gh ${c} -R acme/app *)`, `Bash(gh ${c} -R acme/*)`]),
    'Bash(gh project item-add 3 --owner acme *)',
  ];
  const bad = [
    'Bash', 'Bash(*)', 'Bash( *)', 'Bash(:*)', 'Bash(**)', 'WebFetch', 'WebFetch(*)', 'WebFetch(domain:*)', 'WebSearch', 'WebSearch(x)', 'mcp__x', 'mcp__x__y', 'mcp__x__*', 'Edit', 'Read', 'Write', 'Skill', 'Skill(*)',
    'Read(//etc/**)', 'Read(~/**)', 'Edit(//tmp/**)', 'Edit(/../x)', 'Edit(../x)', 'Edit(//tmp/hq/../etc/**)', 'Edit(//tmp/hq2/**)', 'Read(~/.claude/plugins/**)',
    'Bash(python *)', 'Bash(rm *)', 'Bash(sh *)', 'Bash(node *)', 'Bash(make *)', 'Bash(git push *)', 'Bash(git reset *)', 'Bash(pnpm *)', 'Bash(cat /etc/x *)', 'Bash(git *)', 'Bash(gh api *)', 'Bash(npm exec *)', 'Task(x)', 'not a rule',
  ];
  it('keeps every rule the plugin generates', () => {
    const { kept, dropped } = filterAllowRules(planGood, hq);
    expect(dropped).toEqual([]);
    expect(kept).toEqual(planGood);
  });
  it('drops the broad ones', () => {
    const { kept, dropped } = filterAllowRules(bad, hq);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(bad);
  });
  it('keeps exact commands of an exact-only program', () => {
    expect(filterAllowRules(['Bash(make test)', 'Bash(git push origin x)'], hq).kept).toEqual(['Bash(make test)', 'Bash(git push origin x)']);
  });
  it('keeps order and splits a mixed list', () => {
    expect(filterAllowRules(['Edit(/**)', 'Bash', 'Bash(git add *)'], hq)).toEqual({ kept: ['Edit(/**)', 'Bash(git add *)'], dropped: ['Bash'] });
  });
});

describe('readHqPermissionRules', () => {
  let hq: string;
  beforeEach(() => {
    hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-rules-'));
    fs.mkdirSync(path.join(hq, '.claude'));
  });
  afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));
  const w = (f: string, text: string) => fs.writeFileSync(path.join(hq, '.claude', f), text);

  it('returns nothing when files are missing or invalid', () => {
    expect(readHqPermissionRules(hq)).toMatchObject({ allow: [], deny: [] });
    w('settings.json', '{ not json');
    w('settings.local.json', '[]');
    expect(readHqPermissionRules(hq)).toMatchObject({ allow: [], deny: [] });
  });
  it('merges both files, dedupes and skips odd entries', () => {
    w('settings.json', JSON.stringify({ permissions: { allow: ['A', 'B', 3, 'multi\nline', ''], deny: ['D'] } }));
    w('settings.local.json', JSON.stringify({ permissions: { allow: ['B', 'C'], deny: ['D', 'E'] } }));
    expect(readHqPermissionRules(hq)).toMatchObject({ allow: ['A', 'B', 'C'], deny: ['D', 'E'] });
  });
});

describe('readDenyRules', () => {
  it('reads only permissions.deny', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-deny-')), 'settings.json');
    try {
      fs.writeFileSync(f, JSON.stringify({ model: 'x', permissions: { allow: ['A'], deny: ['D', 3, 'a\nb', ''], defaultMode: 'plan' } }));
      expect(readDenyRules(f)).toEqual(['D']);
      expect(readDenyRules(path.join(path.dirname(f), 'missing.json'))).toEqual([]);
    } finally {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    }
  });
});

describe('filterHqAllowRules: exact dangerous rules from the committed file', () => {
  it('drops them from settings.json but keeps them when the user wrote them in settings.local.json', async () => {
    const { filterHqAllowRules, readHqPermissionRules } = await import('../../src/main/claude/rules');
    const hq = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-rules-')));
    try {
      fs.mkdirSync(path.join(hq, '.claude'));
      const shared = ['Bash(rm -rf x)', 'Bash(git push origin main)', 'Bash(gh issue list *)', 'Bash(make test)'];
      fs.writeFileSync(path.join(hq, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: shared } }));
      fs.writeFileSync(path.join(hq, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }));
      const r = filterHqAllowRules(readHqPermissionRules(hq), hq);
      expect(r.kept).toEqual(expect.arrayContaining(['Bash(gh issue list *)', 'Bash(make test)']));
      expect(r.dropped).toEqual(expect.arrayContaining(['Bash(rm -rf x)', 'Bash(git push origin main)']));
      expect(r.kept).not.toContain('Bash(rm -rf x)');
    } finally {
      fs.rmSync(hq, { recursive: true, force: true });
    }
  });
});

describe('no wildcard inside a shell or interpreter command, from either file', () => {
  const hq = '/tmp/hq';
  it('drops the old boot-set check rule and its kin: the wildcard spans arguments', () => {
    const rules = [
      'Bash(sh *check-boot-set.sh*)', 'Bash(sh x*)', 'Bash(bash *x.sh)', 'Bash(zsh -c *)', 'Bash(python3 *y.py*)', 'Bash(node *.js)',
      'Bash(sh -R a/*)', 'Bash(python -R a/*)', 'Bash(env -R a/*)',
    ];
    const { kept, dropped } = filterAllowRules(rules, hq);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(rules);
  });
  it('drops them from settings.local.json too, and keeps the gh owner pattern', async () => {
    const { filterHqAllowRules } = await import('../../src/main/claude/rules');
    const r = filterHqAllowRules({ allow: ['Bash(sh *check-boot-set.sh*)', 'Bash(gh issue create -R acme/*)'], deny: [], sharedOnlyAllow: [] }, hq);
    expect(r).toEqual({ kept: ['Bash(gh issue create -R acme/*)'], dropped: ['Bash(sh *check-boot-set.sh*)'] });
  });
});

describe('path allow rules naming configuration', () => {
  const hq = '/tmp/hq';
  it('drops them in every form, for reads and edits', () => {
    const rules = [
      'Edit(.claude/**)', 'Edit(/.claude/**)', 'Edit(/.claude/settings.json)', 'Edit(//tmp/hq/.claude/**)', 'Read(//tmp/hq/.claude/**)',
      'Edit(.git/hooks/**)', 'Edit(/.git/hooks/pre-commit)', 'Edit(.mcp.json)', 'Edit(/.mcp.json)', 'Write(/sub/CLAUDE.md)', 'Edit(AGENTS.md)',
      'Edit(/.husky/**)', 'Read(/.github/**)', 'Edit(/.vscode/tasks.json)', 'Edit(/.Claude/x)', 'Edit(/.c*/**)', 'Edit(/.*)',
    ];
    const { kept, dropped } = filterAllowRules(rules, hq);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(rules);
  });
  it('drops edit rules for files that run code later, keeps reads of them', () => {
    const edits = ['Edit(/package.json)', 'Edit(/Makefile)', 'Edit(/scripts/**)', 'Edit(/.env)', 'Edit(/.envrc)', 'Edit(/.gitattributes)', 'Write(//tmp/hq/sub/package.json)'];
    expect(filterAllowRules(edits, hq).kept).toEqual([]);
    expect(filterAllowRules(['Read(/package.json)', 'Read(/scripts/**)'], hq).kept).toEqual(['Read(/package.json)', 'Read(/scripts/**)']);
  });
  it('checks an absolute rule on its hq-relative part only', () => {
    const inScripts = '/tmp/scripts/hq';
    expect(filterAllowRules(['Edit(//tmp/scripts/hq/inbox/**)', 'Edit(/inbox/**)'], inScripts).kept).toEqual(['Edit(//tmp/scripts/hq/inbox/**)', 'Edit(/inbox/**)']);
    expect(validateRule('Edit(//tmp/scripts/hq/inbox/n.md)', 'Edit', inScripts)).toBe(true);
  });
});

describe('no Always allow for files that run code later', () => {
  const files = [
    '.husky/pre-commit', '.github/workflows/ci.yml', '.vscode/tasks.json', 'package.json', 'sub/package.json', 'Makefile', 'scripts/build.sh',
    '.env', '.env.local', '.envrc', '.gitignore', '.gitattributes', '.gitmodules',
  ];
  it('proposes nothing and accepts no edited rule inside the hq', () => {
    for (const f of files) {
      expect(ruleFor('Write', { file_path: `/tmp/hq/${f}` }, HQ), f).toBe('');
      expect(validateRule(`Edit(/${f})`, 'Edit', HQ), f).toBe(false);
    }
  });
  it('nor for a launch agent', () => {
    expect(ruleFor('Write', { file_path: '/Users/u/Library/LaunchAgents/x.plist' }, HQ)).toBe('');
    expect(validateRule('Edit(//Users/u/Library/LaunchAgents/x.plist)', 'Write', HQ)).toBe(false);
    expect(validateRule('Edit(//Library/LaunchAgents/x.plist)', 'Write', HQ)).toBe(false);
  });
  it('still proposes ordinary files', () => {
    expect(ruleFor('Write', { file_path: '/tmp/hq/notes/scripts.md' }, HQ)).toBe('Edit(/notes/scripts.md)');
    expect(validateRule('Edit(/docs/package-notes.md)', 'Edit', HQ)).toBe(true);
  });
});

describe('ruleFor (AskUserQuestion)', () => {
  it('never proposes a rule', () => {
    expect(ruleFor('AskUserQuestion', { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }, HQ)).toBe('');
  });
});
