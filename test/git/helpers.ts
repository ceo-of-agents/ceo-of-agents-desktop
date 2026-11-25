import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coa-git-'));
}

export function commit(repo: string, name: string): void {
  fs.writeFileSync(path.join(repo, name), `${name}\n${Math.random()}\n`);
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', `add ${name}`);
}

export interface Fixture {
  root: string;
  bare: string;
  hq: string;
  clone(name: string): string;
}

/** A bare remote, an hq clone with one pushed commit on branch main. */
export function makeFixture(withRemote = true): Fixture {
  const root = tmp();
  const bare = path.join(root, 'remote.git');
  const hq = path.join(root, 'hq');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  fs.mkdirSync(hq);
  sh(hq, 'init', '-q', '-b', 'main');
  commit(hq, 'a.md');
  if (withRemote) {
    sh(hq, 'remote', 'add', 'origin', bare);
    sh(hq, 'push', '-q', '-u', 'origin', 'main');
  }
  return {
    root,
    bare,
    hq,
    clone(name: string) {
      const p = path.join(root, name);
      execFileSync('git', ['clone', '-q', bare, p]);
      return p;
    },
  };
}

export function cleanup(f: Fixture): void {
  fs.rmSync(f.root, { recursive: true, force: true });
}
