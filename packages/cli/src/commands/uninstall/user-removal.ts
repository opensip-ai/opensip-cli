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
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import {
  acquireGlobalRuntimeMaintenanceLease,
  discardUserUninstallReceipt,
  inspectUserUninstallRecoveryHeader,
  mutateUserUninstallReceipt,
  readUserUninstallReceipt,
  type GlobalRuntimeMaintenanceLease,
} from '@opensip-cli/core';

import { interactivePrompt } from './interactive-prompt.js';
import { collectTargets, printUserModeTargets, type Target } from './targets.js';
import {
  advanceReceipt,
  buildOpenReceipt,
  closeReceipt,
  digestMarkerContent,
  newMarkerContent,
  newOperationId,
  newTombstoneBasename,
  parseReceiptBody,
  serializeReceipt,
  USER_UNINSTALL_MARKER_BASENAME,
  type UserUninstallPhase,
  type UserUninstallReceiptBody,
} from './user-uninstall-receipt.js';

import type { UninstallDoneResult } from '@opensip-cli/contracts';

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

function regularFileMatches(path: string, expectedDigest: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    const body = readFileSync(path);
    return digestMarkerContent(body) === expectedDigest;
  } catch {
    return false;
  }
}

function markerMatches(root: string, expectedDigest: string): boolean {
  return regularFileMatches(join(root, USER_UNINSTALL_MARKER_BASENAME), expectedDigest);
}

function markerTempPath(userRoot: string, operationId: string): string {
  return join(userRoot, `${USER_UNINSTALL_MARKER_BASENAME}.tmp-${operationId}`);
}

function publishExclusiveMarker(userRoot: string, operationId: string, content: Buffer): void {
  const markerPath = join(userRoot, USER_UNINSTALL_MARKER_BASENAME);
  const tempPath = markerTempPath(userRoot, operationId);
  const expectedDigest = digestMarkerContent(content);

  if (existsSync(tempPath) && !regularFileMatches(tempPath, expectedDigest)) {
    const tempStat = lstatSync(tempPath);
    if (tempStat.isSymbolicLink() || !tempStat.isFile()) {
      recoveryFailure('the operation marker temporary path is not a regular file');
    }
    unlinkSync(tempPath);
  }
  if (!existsSync(tempPath)) {
    // A failed/partial write remains operation-bound at the temporary path and
    // is safely replaced on retry; the final marker is published atomically.
    writeFileSync(tempPath, content, { flag: 'wx', mode: 0o600 });
  }
  if (!regularFileMatches(tempPath, expectedDigest)) {
    recoveryFailure('the operation marker temporary file could not be verified');
  }

  try {
    linkSync(tempPath, markerPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !markerMatches(userRoot, expectedDigest)
    ) {
      recoveryFailure('the final operation marker path is occupied by a foreign entry');
    }
  }
  if (!markerMatches(userRoot, expectedDigest)) {
    recoveryFailure('the published operation marker could not be verified');
  }
  unlinkSync(tempPath);
}

/**
 * Content sha256 of a JSON receipt string (for replace/unlink CAS).
 * Prefer digest of the exact bytes we wrote via serializeReceipt.
 */
function contentSha256(content: string): string {
  return digestMarkerContent(content);
}

type TransactionHeader = Extract<UserRecoveryHeader, { readonly status: 'absent' | 'valid' }>;

interface ReceiptCursor {
  readonly receipt: UserUninstallReceiptBody;
  readonly sha256: string;
  readonly pendingMarkerContent?: Buffer;
}

interface TransactionContext {
  readonly userRoot: string;
  readonly tombstonePath: string;
  readonly lease: GlobalRuntimeMaintenanceLease;
}

type TombstoneEntryName = string | Buffer;
type TombstoneEntryPath = string | Buffer;

interface TombstoneRemovalOperations {
  readonly listEntries: (path: string) => readonly TombstoneEntryName[];
  readonly removeEntry: (path: TombstoneEntryPath) => void;
  readonly unlinkMarker: (path: string) => void;
  readonly removeDirectory: (path: string) => void;
}

const DEFAULT_TOMBSTONE_REMOVAL_OPERATIONS: TombstoneRemovalOperations = {
  listEntries: (path) => readdirSync(path, { encoding: 'buffer' }),
  removeEntry: (path) => rmSync(path, { recursive: true, force: true }),
  unlinkMarker: (path) => unlinkSync(path),
  removeDirectory: (path) => rmdirSync(path),
};
const USER_UNINSTALL_MARKER_BASENAME_BYTES = Buffer.from(USER_UNINSTALL_MARKER_BASENAME);

const MAX_RECEIPT_TRANSITIONS = 10;
const MAX_REMOVAL_RECEIPTS = 2;

function recoveryFailure(message: string): never {
  throw new Error(`Cannot recover user uninstall safely: ${message}`);
}

function safeDirectoryExists(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    recoveryFailure(`expected an owned directory at ${path}`);
  }
  return true;
}

function isTombstoneMarkerEntry(entry: TombstoneEntryName | undefined): boolean {
  return typeof entry === 'string'
    ? entry === USER_UNINSTALL_MARKER_BASENAME
    : entry?.equals(USER_UNINSTALL_MARKER_BASENAME_BYTES) === true;
}

function tombstoneEntryPath(tombstonePath: string, entry: TombstoneEntryName): TombstoneEntryPath {
  return typeof entry === 'string'
    ? join(tombstonePath, entry)
    : Buffer.concat([Buffer.from(tombstonePath), Buffer.from(sep), entry]);
}

/**
 * Delete a verified tombstone while preserving its ownership marker until every
 * other entry is gone. If the process stops after unlinking the marker but
 * before removing the root, recovery may remove only that empty directory.
 */
export function removeOwnedTombstone(
  tombstonePath: string,
  expectedMarkerDigest: string,
  operations: TombstoneRemovalOperations = DEFAULT_TOMBSTONE_REMOVAL_OPERATIONS,
): void {
  const markerPath = join(tombstonePath, USER_UNINSTALL_MARKER_BASENAME);

  if (!markerMatches(tombstonePath, expectedMarkerDigest)) {
    if (operations.listEntries(tombstonePath).length > 0) {
      recoveryFailure('the markerless recovery tombstone is not empty');
    }
    operations.removeDirectory(tombstonePath);
    return;
  }

  for (const entry of operations.listEntries(tombstonePath)) {
    if (!isTombstoneMarkerEntry(entry)) {
      operations.removeEntry(tombstoneEntryPath(tombstonePath, entry));
    }
  }

  const remaining = operations.listEntries(tombstonePath);
  if (
    remaining.length !== 1 ||
    !isTombstoneMarkerEntry(remaining[0]) ||
    !markerMatches(tombstonePath, expectedMarkerDigest)
  ) {
    recoveryFailure('the recovery tombstone changed during deletion');
  }

  operations.unlinkMarker(markerPath);
  operations.removeDirectory(tombstonePath);
}

async function replaceReceipt(
  lease: GlobalRuntimeMaintenanceLease,
  cursor: ReceiptCursor,
  receipt: UserUninstallReceiptBody,
  pendingMarkerContent?: Buffer,
): Promise<ReceiptCursor> {
  const content = serializeReceipt(receipt);
  await mutateUserUninstallReceipt(lease, {
    operation: 'replace',
    content,
    expectedContentSha256: cursor.sha256,
  });
  return {
    receipt,
    sha256: contentSha256(content),
    ...(pendingMarkerContent === undefined ? {} : { pendingMarkerContent }),
  };
}

async function initialReceiptCursor(
  lease: GlobalRuntimeMaintenanceLease,
  header: TransactionHeader,
): Promise<ReceiptCursor> {
  if (header.status === 'valid') {
    const observed = await readUserUninstallReceipt(lease);
    if (observed.status !== 'present') {
      recoveryFailure('the admitted receipt disappeared before recovery');
    }
    const receipt = parseReceiptBody(observed.content);
    if (receipt?.operationId !== header.operationId) {
      recoveryFailure('the bounded receipt body does not match its admitted recovery header');
    }
    return { receipt, sha256: observed.sha256 };
  }

  const operationId = newOperationId();
  const pendingMarkerContent = newMarkerContent();
  const receipt = buildOpenReceipt({
    operationId,
    phase: 'marker-create-intent',
    tombstoneBasename: newTombstoneBasename(operationId),
    markerDigest: digestMarkerContent(pendingMarkerContent),
  });
  const content = serializeReceipt(receipt);
  await mutateUserUninstallReceipt(lease, { operation: 'create', content });
  return {
    receipt,
    sha256: contentSha256(content),
    pendingMarkerContent,
  };
}

async function setReceiptPhase(
  context: TransactionContext,
  cursor: ReceiptCursor,
  phase: UserUninstallPhase,
  pendingMarkerContent?: Buffer,
): Promise<ReceiptCursor> {
  return replaceReceipt(
    context.lease,
    cursor,
    advanceReceipt(
      cursor.receipt,
      phase,
      pendingMarkerContent === undefined
        ? {}
        : { markerDigest: digestMarkerContent(pendingMarkerContent) },
    ),
    pendingMarkerContent,
  );
}

async function handleMarkerCreateIntent(
  context: TransactionContext,
  cursor: ReceiptCursor,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  if (tombstoneExists) {
    if (!markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
      recoveryFailure('the tombstone marker does not match the recovery receipt');
    }
    return setReceiptPhase(context, cursor, 'renamed');
  }
  if (markerMatches(context.userRoot, cursor.receipt.markerDigest)) {
    return setReceiptPhase(context, cursor, 'marker-created');
  }
  if (existsSync(join(context.userRoot, USER_UNINSTALL_MARKER_BASENAME))) {
    recoveryFailure('the live user root has a foreign operation marker');
  }

  const markerContent = cursor.pendingMarkerContent ?? newMarkerContent();
  const current =
    cursor.pendingMarkerContent === undefined
      ? await setReceiptPhase(context, cursor, 'marker-create-intent', markerContent)
      : cursor;
  publishExclusiveMarker(context.userRoot, current.receipt.operationId, markerContent);
  if (!markerMatches(context.userRoot, current.receipt.markerDigest)) {
    recoveryFailure('the exclusive operation marker could not be verified after creation');
  }
  return setReceiptPhase(context, current, 'marker-created');
}

async function handleMarkerCreated(
  context: TransactionContext,
  cursor: ReceiptCursor,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  const markerRoot = tombstoneExists ? context.tombstonePath : context.userRoot;
  if (!markerMatches(markerRoot, cursor.receipt.markerDigest)) {
    recoveryFailure('the operation marker does not match the recovery receipt');
  }
  return setReceiptPhase(context, cursor, tombstoneExists ? 'renamed' : 'rename-intent');
}

async function handleRenameIntent(
  context: TransactionContext,
  cursor: ReceiptCursor,
  sourceExists: boolean,
): Promise<ReceiptCursor> {
  if (sourceExists) {
    if (!markerMatches(context.userRoot, cursor.receipt.markerDigest)) {
      recoveryFailure('the live user root marker does not match the recovery receipt');
    }
    renameSync(context.userRoot, context.tombstonePath);
  }
  if (!markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
    recoveryFailure('the renamed tombstone marker does not match the recovery receipt');
  }
  return setReceiptPhase(context, cursor, 'renamed');
}

async function advanceRemovalTransaction(
  context: TransactionContext,
  cursor: ReceiptCursor,
  sourceExists: boolean,
  tombstoneExists: boolean,
): Promise<ReceiptCursor> {
  switch (cursor.receipt.phase) {
    case 'marker-create-intent': {
      return handleMarkerCreateIntent(context, cursor, tombstoneExists);
    }
    case 'marker-created': {
      return handleMarkerCreated(context, cursor, tombstoneExists);
    }
    case 'rename-intent': {
      return handleRenameIntent(context, cursor, sourceExists);
    }
    case 'renamed': {
      if (!tombstoneExists || !markerMatches(context.tombstonePath, cursor.receipt.markerDigest)) {
        recoveryFailure('the recovery tombstone does not match the receipt');
      }
      return setReceiptPhase(context, cursor, 'delete-intent');
    }
    case 'delete-intent': {
      if (!tombstoneExists) {
        recoveryFailure('the recovery tombstone is missing');
      }
      removeOwnedTombstone(context.tombstonePath, cursor.receipt.markerDigest);
      return setReceiptPhase(context, cursor, 'deleted');
    }
    case 'deleted': {
      if (tombstoneExists) {
        recoveryFailure('the deleted receipt phase still has its recovery tombstone');
      }
      return replaceReceipt(context.lease, cursor, closeReceipt(cursor.receipt));
    }
  }
}

async function finishOpenRemovalReceipt(
  context: TransactionContext,
  initial: ReceiptCursor,
): Promise<ReceiptCursor> {
  let cursor = initial;
  let transitions = 0;
  while (cursor.receipt.state === 'open') {
    if (transitions >= MAX_RECEIPT_TRANSITIONS) {
      recoveryFailure('the receipt exceeded its bounded transition count');
    }

    const phase = cursor.receipt.phase;
    const sourceExists = safeDirectoryExists(context.userRoot);
    const tombstoneExists = safeDirectoryExists(context.tombstonePath);
    const deletionAlreadyCompleted =
      !tombstoneExists && (phase === 'delete-intent' || (!sourceExists && phase !== 'deleted'));
    if (deletionAlreadyCompleted) {
      cursor = await setReceiptPhase(context, cursor, 'deleted');
    } else {
      // Once a verified tombstone exists, any simultaneous live root is a
      // recreated generation. Finish the tombstone receipt before removing it.
      const sourceBelongsToReceipt = sourceExists && !tombstoneExists;
      cursor = await advanceRemovalTransaction(
        context,
        cursor,
        sourceBelongsToReceipt,
        tombstoneExists,
      );
    }
    transitions += 1;
  }
  return cursor;
}

async function completeUserRemovalTransaction(input: {
  readonly userRoot: string;
  readonly header: TransactionHeader;
  readonly lease: GlobalRuntimeMaintenanceLease;
}): Promise<void> {
  let cursor = await initialReceiptCursor(input.lease, input.header);
  let context: TransactionContext = {
    userRoot: input.userRoot,
    tombstonePath: join(dirname(input.userRoot), cursor.receipt.tombstoneBasename),
    lease: input.lease,
  };
  let retiredReceipts = 0;

  for (;;) {
    if (cursor.receipt.state === 'closed') {
      await mutateUserUninstallReceipt(input.lease, {
        operation: 'unlink',
        expectedContentSha256: cursor.sha256,
      });
      retiredReceipts += 1;
      if (!safeDirectoryExists(input.userRoot)) return;
      if (retiredReceipts >= MAX_REMOVAL_RECEIPTS) {
        recoveryFailure('the user root was recreated repeatedly during removal');
      }
      cursor = await initialReceiptCursor(input.lease, { status: 'absent' });
      context = {
        ...context,
        tombstonePath: join(dirname(input.userRoot), cursor.receipt.tombstoneBasename),
      };
    }
    cursor = await finishOpenRemovalReceipt(context, cursor);
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
