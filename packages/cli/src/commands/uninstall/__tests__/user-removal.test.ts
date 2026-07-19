/**
 * User uninstall — crash-recoverable path unit coverage with injectable leases.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeUserRemoval } from '../user-removal.js';

import type { GlobalRuntimeMaintenanceLease } from '@opensip-cli/core';

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

function fakeGlobalLease(
  posture: 'normal' | 'user-recovery' | 'receipt-only-discard' = 'normal',
): GlobalRuntimeMaintenanceLease {
  return {
    kind: 'runtime-global-maintenance',
    ownerToken: 'global-owner-token',
    acquiredAt: Date.now(),
    posture,
    receiptOnlyDiscard: posture === 'receipt-only-discard',
    release: vi.fn(),
  };
}

describe('executeUserRemoval', () => {
  let userRoot: string;
  let homeDir: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.HOME;
    homeDir = makeTempDir('user-removal-home');
    process.env.HOME = homeDir;
    userRoot = join(homeDir, '.opensip-cli');
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(join(userRoot, 'config.yml'), 'apiKey: secret\n', 'utf8');
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns empty when the user root is absent', async () => {
    rmSync(userRoot, { recursive: true, force: true });
    const out = captureWrite();
    const result = await executeUserRemoval({
      userRoot,
      yes: true,
      write: out.write,
      acquireGlobalLease: () => Promise.resolve(fakeGlobalLease()),
    });
    expect(result.action).toBe('empty');
    expect(out.text()).toContain('Nothing to remove');
  });

  it('cancels without acquiring a lease when the prompt declines', async () => {
    const acquire = vi.fn(() => Promise.resolve(fakeGlobalLease()));
    const result = await executeUserRemoval({
      userRoot,
      write: captureWrite().write,
      prompt: () => Promise.resolve('n'),
      acquireGlobalLease: acquire,
    });
    expect(result.action).toBe('cancelled');
    expect(existsSync(userRoot)).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('dry-run lists targets without deletion', async () => {
    const acquire = vi.fn(() => Promise.resolve(fakeGlobalLease()));
    const result = await executeUserRemoval({
      userRoot,
      dryRun: true,
      write: captureWrite().write,
      acquireGlobalLease: acquire,
    });
    expect(result.action).toBe('dry-run');
    expect(existsSync(userRoot)).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('refuses discard-recovery for a missing receipt', async () => {
    const result = await executeUserRemoval({
      userRoot,
      discardRecovery: true,
      yes: true,
      write: captureWrite().write,
      acquireGlobalLease: () => Promise.resolve(fakeGlobalLease('receipt-only-discard')),
    });
    expect(result.action).toBe('empty');
    expect(result.recovery?.status).toBe('absent');
  });
});
