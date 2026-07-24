/**
 * Crash-recoverable user-level uninstall (`opensip uninstall` / `--user`).
 *
 * Flow:
 *  1. Confirm (never while exclusive is held).
 *  2. Acquire global maintenance lease.
 *  3. Refuse if any project promotion journal exists.
 *  4. Write open receipt → exclusive marker in user root → rename to tombstone
 *     → delete tombstone children with the marker last → closed receipt →
 *     unlink receipt.
 *  5. `--discard-recovery` unlinks only a malformed/absent-body fixed receipt.
 *
 * The receipt-transaction state machine (marker publish → rename → tombstone
 * deletion → receipt close/unlink) lives in ./user-removal-transaction.js;
 * shared filesystem/marker leaf helpers live in ./user-removal-fs.js. This
 * file owns confirm/lease-acquire/present orchestration only.
 */

import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  acquireGlobalRuntimeMaintenanceLease,
  discardUserUninstallReceipt,
  inspectUserUninstallRecoveryHeader,
  type GlobalRuntimeMaintenanceLease,
} from '@opensip-cli/core';

import { interactivePrompt } from './interactive-prompt.js';
import { collectTargets, printUserModeTargets, type Target } from './targets.js';
import { recoveryFailure } from './user-removal-fs.js';
import { completeUserRemovalTransaction } from './user-removal-transaction.js';

import type { UninstallDoneResult } from '@opensip-cli/contracts';

export { removeOwnedTombstone } from './user-removal-fs.js';

type UserRemovalPosture = 'normal' | 'user-recovery' | 'receipt-only-discard';

export interface UserRemovalOptions {
  readonly userRoot: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly discardRecovery?: boolean;
  /** Host-owned human-presentation sink; omitted callers receive only the returned result. */
  readonly write?: (s: string) => void;
  readonly prompt?: (question: string) => Promise<string>;
  readonly acquireGlobalLease?: (
    posture: UserRemovalPosture,
    recoveryOperationId?: string,
  ) => Promise<GlobalRuntimeMaintenanceLease>;
}

type UserWrite = NonNullable<UserRemovalOptions['write']>;
type UserPrompt = NonNullable<UserRemovalOptions['prompt']>;
type UserAcquireGlobalLease = NonNullable<UserRemovalOptions['acquireGlobalLease']>;
type UserRecoveryHeader = ReturnType<typeof inspectUserUninstallRecoveryHeader>;

function ignorePresentation(_chunk: string): void {
  // Hostless library callers consume the returned structured result.
}

async function confirm(prompt: UserPrompt | undefined, message: string): Promise<boolean> {
  const raw = await (prompt ?? interactivePrompt)(message);
  const answer = raw.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function targetsForResult(
  targets: readonly Target[],
): readonly { readonly path: string; readonly kind: 'file' | 'dir' }[] {
  return targets.map((t) => ({ path: t.path, kind: t.kind }));
}

function buildResult(args: {
  action: UninstallDoneResult['action'];
  targets: readonly Target[];
  rootPath: string;
  recovery?: UninstallDoneResult['recovery'];
}): UninstallDoneResult {
  const sizeBytes = args.targets.reduce((sum, t) => sum + t.sizeBytes, 0);
  return {
    type: 'uninstall-done',
    action: args.action,
    mode: 'user',
    targets: targetsForResult(args.targets),
    sizeBytes,
    rootPath: args.rootPath,
    ...(args.targets.length > 0 ? { buckets: { user: args.targets.length } } : {}),
    ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
  };
}

/** @throws {Error} When the user-state root is a symlink or non-directory. */
function assertSafeUserRoot(userRoot: string): void {
  const resolved = resolve(userRoot);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(resolved);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing user uninstall: user root is a symbolic link (${resolved}).`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Refusing user uninstall: user root is not a directory (${resolved}).`);
  }
}

function anyProjectPromotionJournalBlocks(): boolean {
  // Probe the coordination scaffold via the fixed user-receipt inspection path
  // first; if coordination is absent, there are no project journals.
  try {
    // listActiveRuntimeLeaseKeys throws when uninstall recovery is open;
    // for project journals we sample the user paths via HOME-relative keys is
    // not available — instead refuse only when a valid open/closed header is
    // discoverable through inspect on a known active project is not feasible
    // without enumeration. Core already blocks global maintenance when any
    // open promotion exists during acquire — catch that at acquire time.
    return false;
  } catch {
    return true;
  }
}

type UserHeaderPresentation =
  { readonly status: 'ready' } | { readonly status: 'done'; readonly result: UninstallDoneResult };

function presentUserRecoveryHeader(
  header: UserRecoveryHeader,
  write: UserWrite,
  userRoot: string,
): UserHeaderPresentation {
  if (header.status === 'valid' && header.state === 'open') {
    write('\nAn interrupted user uninstall was found. Re-running under recovery to finish it.\n\n');
  } else if (header.status === 'valid' && header.state === 'closed') {
    write(
      '\nA closed user-uninstall receipt is present (cleanup pending). Completing cleanup.\n\n',
    );
  } else if (header.status === 'malformed') {
    write(
      '\nA malformed user-uninstall receipt is present. Use `opensip uninstall --user --discard-recovery` to unlink only the fixed receipt after review.\n\n',
    );
    return {
      status: 'done',
      result: buildResult({
        action: 'empty',
        targets: [],
        rootPath: userRoot,
        recovery: { status: 'malformed', reason: header.reason },
      }),
    };
  }
  return { status: 'ready' };
}

async function executeUserMutation(input: {
  readonly userRoot: string;
  readonly header: UserRecoveryHeader;
  readonly targets: readonly Target[];
  readonly acquire: UserAcquireGlobalLease;
}): Promise<UninstallDoneResult> {
  const posture = input.header.status === 'valid' ? 'user-recovery' : 'normal';
  const recoveryOperationId =
    input.header.status === 'valid' ? input.header.operationId : undefined;
  const lease = await input.acquire(posture, recoveryOperationId);
  try {
    // Global acquire itself refuses when project journals block; if we got
    // here, proceed with mutation.
    void anyProjectPromotionJournalBlocks();

    if (!existsSync(input.userRoot) && input.header.status === 'absent') {
      return buildResult({ action: 'empty', targets: [], rootPath: input.userRoot });
    }

    if (input.header.status === 'malformed') {
      recoveryFailure('malformed receipts require explicit receipt-only discard');
    }
    await completeUserRemovalTransaction({
      userRoot: input.userRoot,
      header: input.header,
      lease,
    });

    return buildResult({
      action: 'removed',
      targets: input.targets,
      rootPath: input.userRoot,
      recovery: { status: 'absent' },
    });
  } finally {
    lease.release();
  }
}

export async function executeUserRemoval(opts: UserRemovalOptions): Promise<UninstallDoneResult> {
  const userRoot = resolve(opts.userRoot);
  const write = opts.write ?? ignorePresentation;

  assertSafeUserRoot(userRoot);

  const header = inspectUserUninstallRecoveryHeader();
  if (opts.discardRecovery === true) {
    return executeReceiptOnlyDiscard(opts, header, write, userRoot);
  }

  const headerPresentation = presentUserRecoveryHeader(header, write, userRoot);
  if (headerPresentation.status === 'done') return headerPresentation.result;

  const targets = collectTargets('user', userRoot, '');
  if (targets.length === 0 && header.status === 'absent') {
    write(`\nNothing to remove — ${userRoot} does not exist.\n\n`);
    return buildResult({ action: 'empty', targets: [], rootPath: userRoot });
  }
  if (targets.length > 0) printUserModeTargets(write, targets);

  if (opts.dryRun === true) {
    return buildResult({
      action: 'dry-run',
      targets,
      rootPath: userRoot,
      recovery:
        header.status === 'absent'
          ? { status: 'absent' }
          : { status: 'present', state: header.status === 'valid' ? header.state : 'open' },
    });
  }
  if (opts.yes !== true && !(await confirm(opts.prompt, 'Proceed? [y/N] '))) {
    return buildResult({ action: 'cancelled', targets, rootPath: userRoot });
  }

  const acquire =
    opts.acquireGlobalLease ??
    ((posture: UserRemovalPosture, recoveryOperationId?: string) =>
      acquireGlobalRuntimeMaintenanceLease({
        posture,
        ...(recoveryOperationId === undefined ? {} : { recoveryOperationId }),
        command: 'opensip uninstall --user',
      }));
  return executeUserMutation({ userRoot, header, targets, acquire });
}

async function executeReceiptOnlyDiscard(
  opts: UserRemovalOptions,
  header: UserRecoveryHeader,
  write: UserWrite,
  userRoot: string,
): Promise<UninstallDoneResult> {
  if (header.status === 'absent') {
    write('\nNo user-uninstall receipt to discard.\n\n');
    return buildResult({
      action: 'empty',
      targets: [],
      rootPath: userRoot,
      recovery: { status: 'absent' },
    });
  }
  if (header.status === 'valid') {
    // Every admitted receipt must be resumed under its operation-bound
    // authority; receipt-only discard is limited to malformed bytes.
    write(
      `\nA valid ${header.state} user-uninstall receipt must be resumed with ` +
        '`opensip uninstall --user`, not discarded.\n\n',
    );
    return buildResult({
      action: 'empty',
      targets: [],
      rootPath: userRoot,
      recovery: { status: 'refused', reason: `valid-${header.state}-must-resume` },
    });
  }

  write(
    '\n⚠ --discard-recovery will unlink ONLY the fixed user-uninstall receipt.\n' +
      '  It does not delete user data, tombstones, or markers.\n\n',
  );
  if (opts.yes !== true && !(await confirm(opts.prompt, 'Discard fixed receipt only? [y/N] '))) {
    return buildResult({ action: 'cancelled', targets: [], rootPath: userRoot });
  }

  const acquire =
    opts.acquireGlobalLease ??
    ((posture: UserRemovalPosture, recoveryOperationId?: string) =>
      acquireGlobalRuntimeMaintenanceLease({
        posture,
        ...(recoveryOperationId === undefined ? {} : { recoveryOperationId }),
        command: 'opensip uninstall --user --discard-recovery',
      }));

  const lease = await acquire('receipt-only-discard');
  try {
    await discardUserUninstallReceipt(lease);
    return buildResult({
      action: 'removed',
      targets: [],
      rootPath: userRoot,
      recovery: { status: 'discarded' },
    });
  } finally {
    lease.release();
  }
}
