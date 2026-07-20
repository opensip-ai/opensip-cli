/**
 * User uninstall — crash-recoverable path unit coverage with injectable leases.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireGlobalRuntimeMaintenanceLease,
  inspectUserUninstallRecoveryHeader,
  mutateUserUninstallReceipt,
  resolveCoordinationPaths,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeUserRemoval } from '../user-removal.js';
import {
  buildOpenReceipt,
  closeReceipt,
  digestMarkerContent,
  newTombstoneBasename,
  serializeReceipt,
  USER_UNINSTALL_MARKER_BASENAME,
  type UserUninstallPhase,
  type UserUninstallReceiptBody,
} from '../user-uninstall-receipt.js';

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

function seedCoordinationReceipt(
  receipt: UserUninstallReceiptBody | Record<string, unknown>,
): void {
  const paths = resolveCoordinationPaths();
  mkdirSync(paths.coordinationDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.projectsDir, { mode: 0o700 });
  mkdirSync(paths.userReadersDir, { mode: 0o700 });
  const content =
    receipt.kind === 'user-uninstall'
      ? serializeReceipt(receipt as UserUninstallReceiptBody)
      : `${JSON.stringify(receipt)}\n`;
  writeFileSync(paths.userUninstallReceiptFile, content, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

interface CrashFixture {
  readonly label: string;
  readonly phase: UserUninstallPhase;
  readonly state?: 'open' | 'closed';
  readonly location: 'source' | 'tombstone' | 'none';
  readonly marker: boolean;
}

const CRASH_FIXTURES: readonly CrashFixture[] = [
  {
    label: 'before marker creation',
    phase: 'marker-create-intent',
    location: 'source',
    marker: false,
  },
  {
    label: 'after marker creation but before its receipt transition',
    phase: 'marker-create-intent',
    location: 'source',
    marker: true,
  },
  {
    label: 'after marker-created',
    phase: 'marker-created',
    location: 'source',
    marker: true,
  },
  {
    label: 'before the rename filesystem step',
    phase: 'rename-intent',
    location: 'source',
    marker: true,
  },
  {
    label: 'after rename but before its receipt transition',
    phase: 'rename-intent',
    location: 'tombstone',
    marker: true,
  },
  {
    label: 'after renamed',
    phase: 'renamed',
    location: 'tombstone',
    marker: true,
  },
  {
    label: 'before the delete filesystem step',
    phase: 'delete-intent',
    location: 'tombstone',
    marker: true,
  },
  {
    label: 'after delete but before its receipt transition',
    phase: 'delete-intent',
    location: 'none',
    marker: false,
  },
  { label: 'after deleted', phase: 'deleted', location: 'none', marker: false },
  {
    label: 'after the receipt is closed',
    phase: 'deleted',
    state: 'closed',
    location: 'none',
    marker: false,
  },
  {
    label: 'after closed cleanup when user state was recreated',
    phase: 'deleted',
    state: 'closed',
    location: 'source',
    marker: false,
  },
];

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

  it('completes a fresh user uninstall and retires its durable receipt', async () => {
    const result = await executeUserRemoval({
      userRoot,
      yes: true,
      write: captureWrite().write,
    });

    expect(result.action).toBe('removed');
    expect(existsSync(userRoot)).toBe(false);
    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
  });

  it.each(CRASH_FIXTURES)('resumes safely $label', async (fixture) => {
    const operationId = 'uu-0123456789abcdef01234567';
    const tombstoneBasename = newTombstoneBasename(operationId);
    const tombstonePath = join(homeDir, tombstoneBasename);
    const markerContent = Buffer.alloc(32, 0x61);
    const markerDigest = digestMarkerContent(markerContent);
    const openReceipt = buildOpenReceipt({
      operationId,
      phase: fixture.phase,
      tombstoneBasename,
      markerDigest,
    });
    const receipt = fixture.state === 'closed' ? closeReceipt(openReceipt) : openReceipt;

    if (fixture.marker) {
      writeFileSync(join(userRoot, USER_UNINSTALL_MARKER_BASENAME), markerContent, {
        mode: 0o600,
      });
    }
    if (fixture.location === 'tombstone') {
      renameSync(userRoot, tombstonePath);
    } else if (fixture.location === 'none') {
      rmSync(userRoot, { recursive: true, force: true });
    }
    seedCoordinationReceipt(receipt);

    const result = await executeUserRemoval({
      userRoot,
      yes: true,
      write: captureWrite().write,
    });

    expect(result.action).toBe('removed');
    expect(existsSync(userRoot)).toBe(false);
    expect(existsSync(tombstonePath)).toBe(false);
    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
  });

  it('fails closed when a valid header carries an unsafe receipt body', async () => {
    const operationId = 'uu-0123456789abcdef01234567';
    const valid = buildOpenReceipt({
      operationId,
      phase: 'marker-create-intent',
      tombstoneBasename: newTombstoneBasename(operationId),
      markerDigest: 'd'.repeat(64),
    });
    seedCoordinationReceipt({ ...valid, tombstoneBasename: '../outside' });

    await expect(
      executeUserRemoval({
        userRoot,
        yes: true,
        write: captureWrite().write,
      }),
    ).rejects.toThrow(/bounded receipt body/u);
    expect(existsSync(userRoot)).toBe(true);
    expect(inspectUserUninstallRecoveryHeader()).toMatchObject({
      status: 'valid',
      operationId,
    });
  });

  it('uses the same operation when the receipt closes after the pre-lock inspection', async () => {
    const operationId = 'uu-0123456789abcdef01234567';
    const openReceipt = buildOpenReceipt({
      operationId,
      phase: 'delete-intent',
      tombstoneBasename: newTombstoneBasename(operationId),
      markerDigest: 'd'.repeat(64),
    });
    seedCoordinationReceipt(openReceipt);

    const result = await executeUserRemoval({
      userRoot,
      yes: true,
      write: captureWrite().write,
      acquireGlobalLease: async (posture, recoveryOperationId) => {
        expect(posture).toBe('user-recovery');
        expect(recoveryOperationId).toBe(operationId);
        const lease = await acquireGlobalRuntimeMaintenanceLease({
          posture,
          recoveryOperationId,
        });
        const closedReceipt = closeReceipt(openReceipt);
        await mutateUserUninstallReceipt(lease, {
          operation: 'replace',
          content: serializeReceipt(closedReceipt),
          expectedContentSha256: digestMarkerContent(serializeReceipt(openReceipt)),
        });
        rmSync(userRoot, { recursive: true, force: true });
        return lease;
      },
    });

    expect(result.action).toBe('removed');
    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
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

  it.each(['open', 'closed'] as const)(
    'refuses receipt-only discard for a valid %s receipt',
    async (state) => {
      const operationId = 'uu-0123456789abcdef01234567';
      const openReceipt = buildOpenReceipt({
        operationId,
        phase: state === 'closed' ? 'deleted' : 'marker-create-intent',
        tombstoneBasename: newTombstoneBasename(operationId),
        markerDigest: 'd'.repeat(64),
      });
      seedCoordinationReceipt(state === 'closed' ? closeReceipt(openReceipt) : openReceipt);
      const acquire = vi.fn(() => Promise.resolve(fakeGlobalLease('receipt-only-discard')));

      const result = await executeUserRemoval({
        userRoot,
        discardRecovery: true,
        yes: true,
        write: captureWrite().write,
        acquireGlobalLease: acquire,
      });

      expect(result.action).toBe('empty');
      expect(result.recovery).toEqual({
        status: 'refused',
        reason: `valid-${state}-must-resume`,
      });
      expect(acquire).not.toHaveBeenCalled();
    },
  );
});
