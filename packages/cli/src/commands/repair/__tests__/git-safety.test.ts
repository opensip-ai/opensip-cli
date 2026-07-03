import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureRepairWorktreeClean } from '../git-safety.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-repair-git-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ensureRepairWorktreeClean', () => {
  it('allows force mode and empty path sets without invoking git', () => {
    expect(ensureRepairWorktreeClean(root, ['src/a.ts'], true)).toEqual({ ok: true, value: true });
    expect(ensureRepairWorktreeClean(root, [], false)).toEqual({ ok: true, value: true });
  });

  it('returns git-unavailable outside a git worktree', () => {
    const result = ensureRepairWorktreeClean(root, ['src/a.ts'], false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('git-unavailable');
  });

  it('distinguishes clean and dirty paths inside a git worktree', () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'src'), { recursive: true });

    expect(ensureRepairWorktreeClean(root, ['src/a.ts'], false)).toEqual({
      ok: true,
      value: true,
    });

    writeFileSync(join(root, 'src/a.ts'), 'changed\n', 'utf8');
    const dirty = ensureRepairWorktreeClean(root, ['src/a.ts'], false);
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) expect(dirty.error.code).toBe('dirty-worktree');
  });
});
