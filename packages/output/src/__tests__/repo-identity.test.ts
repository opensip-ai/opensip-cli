import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { resolveRepoIdentity } from '../sink/repo-identity.js';

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'repoid-'));

function gitInit(repo: string, opts: { origin?: string } = {}): void {
  const g = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  g('init', '-q');
  g('config', 'user.email', 't@test.local');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  if (opts.origin) g('remote', 'add', 'origin', opts.origin);
  g('commit', '-q', '--allow-empty', '-m', 'init');
}

describe('resolveRepoIdentity', () => {
  it('reads HEAD sha + origin remote from a real git repo', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repoid-git-'));
    gitInit(repo, { origin: 'https://github.com/acme/widget.git' });

    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();

    const identity = resolveRepoIdentity(repo);
    expect(identity.commit).toBe(expectedSha);
    expect(identity.remoteUrl).toBe('https://github.com/acme/widget.git');
  });

  it('leaves fields undefined for a non-git directory (never throws)', async () => {
    const notARepo = await dir();
    const identity = resolveRepoIdentity(notARepo);
    expect(identity).toEqual({ commit: undefined, remoteUrl: undefined });
  });

  it('leaves remoteUrl undefined when there is no origin remote', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repoid-noorigin-'));
    gitInit(repo);

    const identity = resolveRepoIdentity(repo);
    expect(identity.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.remoteUrl).toBeUndefined();
  });
});
