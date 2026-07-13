import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureTaskContextSourceIdentity,
  taskContextSourceIdentityEqual,
} from '../task-context-source-identity.js';

const tempDirs: string[] = [];

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(cwd: string, relativePath: string, content: string): void {
  const path = join(cwd, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'task-context-source-'));
  tempDirs.push(cwd);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'context@example.test']);
  git(cwd, ['config', 'user.name', 'Context Test']);
  write(cwd, 'src/tracked.ts', 'export const value = 1;\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'initial']);
  return cwd;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('captureTaskContextSourceIdentity', () => {
  it('is stable when the repository state is unchanged', async () => {
    const cwd = repository();
    const first = await captureTaskContextSourceIdentity({ cwd });
    const second = await captureTaskContextSourceIdentity({ cwd });

    expect(first.status).toBe('captured');
    expect(first.dirty).toBe(false);
    expect(taskContextSourceIdentityEqual(first, second)).toBe(true);
  });

  it('detects content changes to a tracked file that was already dirty', async () => {
    const cwd = repository();
    write(cwd, 'src/tracked.ts', 'export const value = 2;\n');
    const first = await captureTaskContextSourceIdentity({ cwd });
    write(cwd, 'src/tracked.ts', 'export const value = 3;\n');
    const second = await captureTaskContextSourceIdentity({ cwd });

    expect(first.status).toBe('captured');
    expect(first.dirty).toBe(true);
    expect(second.status).toBe('captured');
    expect(first.worktreeIdentity).not.toBe(second.worktreeIdentity);
  });

  it('detects relevant untracked content and exposes only an opaque digest', async () => {
    const cwd = repository();
    const privatePath = 'src/private-task-name.ts';
    const privateContent = 'export const privateToken = "first-secret";\n';
    write(cwd, privatePath, privateContent);
    const first = await captureTaskContextSourceIdentity({ cwd });
    write(cwd, privatePath, 'export const privateToken = "second-secret";\n');
    const second = await captureTaskContextSourceIdentity({ cwd });

    expect(first.status).toBe('captured');
    expect(first.dirty).toBe(true);
    expect(first.worktreeIdentity).not.toBe(second.worktreeIdentity);
    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('second-secret');
    expect(first.worktreeIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('captures a nested project subtree without hashing changes outside that scope', async () => {
    const root = repository();
    write(root, 'apps/customer/src/work.ts', 'export const work = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'add nested project']);
    const cwd = join(root, 'apps/customer');
    const clean = await captureTaskContextSourceIdentity({ cwd });

    write(root, 'src/tracked.ts', 'export const value = 2;\n');
    const outsideDirty = await captureTaskContextSourceIdentity({ cwd });
    expect(outsideDirty).toEqual(clean);

    write(cwd, 'src/work.ts', 'export const work = 2;\n');
    const insideDirty = await captureTaskContextSourceIdentity({ cwd });
    expect(insideDirty.status).toBe('captured');
    expect(insideDirty.dirty).toBe(true);
    expect(insideDirty.worktreeIdentity).not.toBe(clean.worktreeIdentity);
  });
});
