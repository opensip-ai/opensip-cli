import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveChangedFiles } from '../git-changed-files.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('resolveChangedFiles', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        git(d, ['checkout', '.']);
      } catch {
        /* ignore */
      }
    }
  });

  it('returns not-a-repo outside git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-nogit-'));
    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-a-repo');
  });

  it('detects working-tree changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.txt'), '1\n', 'utf8');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);
    writeFileSync(join(dir, 'b.txt'), '2\n', 'utf8');
    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toContain('b.txt');
  });

  it('rejects bad since refs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.txt'), '1\n', 'utf8');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);
    const dash = resolveChangedFiles(dir, { since: '--output=/x' });
    expect(dash.ok).toBe(false);
    if (!dash.ok) expect(dash.reason).toBe('bad-ref');
    const missing = resolveChangedFiles(dir, { since: 'no-such-ref-xyz' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('bad-ref');
  });
});
