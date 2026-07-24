import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(dir, 'a.txt'), 'changed\n', 'utf8');
    writeFileSync(join(dir, 'b.txt'), '2\n', 'utf8');
    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toContain('a.txt');
      expect(r.files).toContain('b.txt');
      expect(r.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'a.txt', status: 'modified' }),
          expect.objectContaining({ path: 'b.txt', status: 'untracked' }),
        ]),
      );
    }
  });

  it('reports git-unavailable when HEAD diff cannot run before the first commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);

    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('git-unavailable');
      expect(r.message).toBe('Git diff failed');
    }
  });

  it('returns an empty file set for a clean working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.txt'), '1\n', 'utf8');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);

    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toEqual([]);
      expect(r.basis).toEqual({ type: 'changed', source: 'git' });
      expect(r.entries).toEqual([]);
    }
  });

  it('lists files committed since a ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'a.txt'), '1\n', 'utf8');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);
    writeFileSync(join(dir, 'b.txt'), '2\n', 'utf8');
    git(dir, ['add', 'b.txt']);
    git(dir, ['commit', '-m', 'second']);
    // Regression guard: the diff range must not sit after `--` (that would read
    // it as a pathspec and return zero files).
    const r = resolveChangedFiles(dir, { since: 'HEAD~1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toContain('b.txt');
      expect(r.files).not.toContain('a.txt');
      expect(r.basis.ref).toBe('HEAD~1');
      expect(r.entries).toContainEqual(expect.objectContaining({ path: 'b.txt', status: 'added' }));
    }
  });

  it('reports deleted and renamed file entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    writeFileSync(join(dir, 'delete-me.txt'), '1\n', 'utf8');
    writeFileSync(join(dir, 'rename-me.txt'), 'same content\n', 'utf8');
    git(dir, ['add', 'delete-me.txt', 'rename-me.txt']);
    git(dir, ['commit', '-m', 'init']);
    rmSync(join(dir, 'delete-me.txt'));
    git(dir, ['mv', 'rename-me.txt', 'renamed.txt']);

    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'delete-me.txt', status: 'deleted' }),
          expect.objectContaining({
            path: 'renamed.txt',
            previousPath: 'rename-me.txt',
            status: 'renamed',
          }),
        ]),
      );
      expect(r.files).toEqual(expect.arrayContaining(['delete-me.txt', 'renamed.txt']));
    }
  });

  it('preserves non-ASCII paths against core.quotepath C-quoting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-git-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    // Force the default quoting behavior the -z parser must be immune to.
    git(dir, ['config', 'core.quotepath', 'true']);
    // Cyrillic/CJK names have no NFD decomposition, so APFS stores them as written.
    writeFileSync(join(dir, '数据.txt'), '1\n', 'utf8');
    git(dir, ['add', '数据.txt']);
    git(dir, ['commit', '-m', 'init']);
    writeFileSync(join(dir, '数据.txt'), 'changed\n', 'utf8');
    writeFileSync(join(dir, 'скетч.txt'), '2\n', 'utf8');

    const r = resolveChangedFiles(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '数据.txt', status: 'modified' }),
          expect.objectContaining({ path: 'скетч.txt', status: 'untracked' }),
        ]),
      );
    }
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
