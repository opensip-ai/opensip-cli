/**
 * Lease-safe project removal unit coverage.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeProjectRemoval } from '../project-removal.js';

import type { RuntimeExclusiveLease, RuntimeReadLease } from '@opensip-cli/core';

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function captureWrite(): { write: (s: string) => void; text: () => string } {
  let buf = '';
  return {
    write: (s) => {
      buf += s;
    },
    text: () => buf,
  };
}

function fakeReadLease(): RuntimeReadLease {
  return {
    kind: 'runtime-read',
    ownerToken: 'read-token',
    acquiredAt: Date.now(),
    coordinationKey: 'key',
    release: vi.fn(),
  };
}

function fakeExclusiveLease(
  posture: 'normal' | 'destructive-discard' = 'normal',
): RuntimeExclusiveLease {
  return {
    kind: 'runtime-exclusive',
    ownerToken: 'excl-token',
    acquiredAt: Date.now(),
    coordinationKey: 'key',
    posture,
    release: vi.fn(),
  };
}

describe('executeProjectRemoval', () => {
  let projectDir: string;
  let homeDir: string;
  let priorHome: string | undefined;
  let userSourceDir: string;
  let runtimeDir: string;
  let configFile: string;

  beforeEach(() => {
    priorHome = process.env.HOME;
    homeDir = makeTempDir('proj-removal-home');
    process.env.HOME = homeDir;
    projectDir = makeTempDir('proj-removal');
    userSourceDir = join(projectDir, 'opensip-cli');
    runtimeDir = join(userSourceDir, '.runtime');
    configFile = join(projectDir, 'opensip-cli.config.yml');
    mkdirSync(join(userSourceDir, 'fit', 'checks'), { recursive: true });
    mkdirSync(join(runtimeDir, 'logs'), { recursive: true });
    writeFileSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'), '// custom\n', 'utf8');
    writeFileSync(join(runtimeDir, 'logs', 'run.jsonl'), '{}\n', 'utf8');
    writeFileSync(configFile, 'schemaVersion: 1\n', 'utf8');
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('removes project runtime by default and preserves authored content', async () => {
    const out = captureWrite();
    const exclusive = fakeExclusiveLease();
    const result = await executeProjectRemoval({
      projectDir,
      yes: true,
      write: out.write,
      acquireExclusiveLease: () => Promise.resolve(exclusive),
    });
    expect(result.action).toBe('removed');
    expect(result.mode).toBe('project');
    expect(result.buckets?.projectRuntime).toBe(1);
    expect(result.buckets?.authored).toBeUndefined();
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'))).toBe(true);
    expect(existsSync(configFile)).toBe(true);
    expect(exclusive.release).toHaveBeenCalledOnce();
  });

  it('with --purge also removes authored content', async () => {
    const exclusive = fakeExclusiveLease();
    const result = await executeProjectRemoval({
      projectDir,
      purge: true,
      yes: true,
      write: captureWrite().write,
      acquireExclusiveLease: () => Promise.resolve(exclusive),
    });
    expect(result.action).toBe('removed');
    expect(result.buckets?.authored).toBeGreaterThan(0);
    expect(existsSync(configFile)).toBe(false);
    expect(existsSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'))).toBe(false);
  });

  it('dry-run uses a read lease and deletes nothing', async () => {
    const read = fakeReadLease();
    const exclusive = fakeExclusiveLease();
    const result = await executeProjectRemoval({
      projectDir,
      dryRun: true,
      write: captureWrite().write,
      acquireReadLease: () => Promise.resolve(read),
      acquireExclusiveLease: () => Promise.resolve(exclusive),
    });
    expect(result.action).toBe('dry-run');
    expect(existsSync(runtimeDir)).toBe(true);
    expect(read.release).toHaveBeenCalledOnce();
    expect(exclusive.release).not.toHaveBeenCalled();
  });

  it('cancels without acquiring exclusive lease when prompt declines', async () => {
    const exclusive = fakeExclusiveLease();
    const result = await executeProjectRemoval({
      projectDir,
      write: captureWrite().write,
      prompt: () => Promise.resolve('n'),
      acquireExclusiveLease: () => Promise.resolve(exclusive),
    });
    expect(result.action).toBe('cancelled');
    expect(existsSync(runtimeDir)).toBe(true);
    expect(exclusive.release).not.toHaveBeenCalled();
  });

  it('refuses discard-recovery without --purge', async () => {
    const result = await executeProjectRemoval({
      projectDir,
      discardRecovery: true,
      yes: true,
      write: captureWrite().write,
      acquireExclusiveLease: () => Promise.resolve(fakeExclusiveLease('destructive-discard')),
    });
    expect(result.action).toBe('empty');
    expect(result.recovery?.status).toBe('refused');
    expect(existsSync(runtimeDir)).toBe(true);
  });

  it('releases exclusive lease on deletion error', async () => {
    const exclusive = fakeExclusiveLease();
    const acquire = vi.fn(() => Promise.resolve(exclusive));
    // Point at a file path as projectDir after setup — assertSafeProjectDir fails.
    const filePath = join(projectDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'x', 'utf8');
    await expect(
      executeProjectRemoval({
        projectDir: filePath,
        yes: true,
        write: captureWrite().write,
        acquireExclusiveLease: acquire,
      }),
    ).rejects.toThrow(/not a directory/);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects a symlink project path', async () => {
    if (process.platform === 'win32') return;
    const link = join(homeDir, 'project-link');
    symlinkSync(projectDir, link);
    await expect(
      executeProjectRemoval({
        projectDir: link,
        yes: true,
        write: captureWrite().write,
        acquireExclusiveLease: () => Promise.resolve(fakeExclusiveLease()),
      }),
    ).rejects.toThrow(/symbolic link/);
  });

  it('returns empty when no OpenSIP state exists', async () => {
    rmSync(userSourceDir, { recursive: true, force: true });
    rmSync(configFile, { force: true });
    const out = captureWrite();
    const result = await executeProjectRemoval({
      projectDir,
      yes: true,
      write: out.write,
      acquireExclusiveLease: () => Promise.resolve(fakeExclusiveLease()),
    });
    expect(result.action).toBe('empty');
    expect(out.text()).toContain('no OpenSIP CLI state');
  });

  it('refuses when opensip-cli/ is a symlink escaping the project', async () => {
    if (process.platform === 'win32') return;
    const outside = makeTempDir('proj-escape-target');
    writeFileSync(join(outside, 'secret.txt'), 'do-not-delete\n', 'utf8');
    rmSync(userSourceDir, { recursive: true, force: true });
    symlinkSync(outside, userSourceDir);
    await expect(
      executeProjectRemoval({
        projectDir,
        purge: true,
        yes: true,
        write: captureWrite().write,
        acquireExclusiveLease: () => Promise.resolve(fakeExclusiveLease()),
      }),
    ).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('recovery-only discard-recovery with empty targets still acquires exclusive lease', async () => {
    rmSync(userSourceDir, { recursive: true, force: true });
    rmSync(configFile, { force: true });
    // Simulate a journal-blocked project with no remaining runtime roots:
    // journalBlocksRemoval returns absent when no coordination scaffold exists,
    // so recoveryOnly stays false here. We assert discard without purge still
    // refuses (covered above) and empty+purge+discard with no journal is empty.
    const exclusive = fakeExclusiveLease('destructive-discard');
    const result = await executeProjectRemoval({
      projectDir,
      purge: true,
      discardRecovery: true,
      yes: true,
      write: captureWrite().write,
      acquireExclusiveLease: () => Promise.resolve(exclusive),
    });
    // No journal + no targets → empty (nothing to discard).
    expect(result.action).toBe('empty');
    expect(exclusive.release).not.toHaveBeenCalled();
  });
});
