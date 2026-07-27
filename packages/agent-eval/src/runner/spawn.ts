import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasControlCharacter } from '../control-text.js';

import { buildDeterministicEnv } from './env.js';
import {
  processTreeIsAlive,
  processTreeSummary,
  processTreeTrackingReliable,
  retainPosixProcessTree,
  sampleProcessTree,
  sampleProcessTreeIfDue,
  signalProcessTree,
  stopProcessTreeTracking,
} from './process-tree.js';

import type { ProcessSnapshot, ProcessTreeSummary } from './process-tree.js';
import type { BigIntStats } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_INSTALLED_ENTRYPOINT_BYTES = 16 * 1024 * 1024;
export const MAX_INSTALLED_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGE_ANCESTORS = 64;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_FILES = 100_000;
const MAX_SNAPSHOT_ENTRIES = 200_000;
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_PACKAGES = 2048;
const KILL_GRACE_MS = 250;
const KILL_SETTLE_MS = 1000;
const FORCE_SETTLE_MS = KILL_GRACE_MS + KILL_SETTLE_MS + 1000;
const TRUNCATION_MARKER = '[output truncated]\n';
const SNAPSHOT_RESOLUTION_GUARD_SOURCE = [
  "'use strict';",
  "const { registerHooks } = require('node:module');",
  "const { fileURLToPath } = require('node:url');",
  "const { isAbsolute, relative, sep } = require('node:path');",
  'const snapshotRoot = __dirname;',
  'function isWithinSnapshot(path) {',
  '  const fromRoot = relative(snapshotRoot, path);',
  "  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));",
  '}',
  'registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    const resolved = nextResolve(specifier, context);',
  "    if (resolved.url.startsWith('node:')) return resolved;",
  "    if (resolved.url.startsWith('file:') && isWithinSnapshot(fileURLToPath(resolved.url))) return resolved;",
  "    throw new Error('Installed CLI module resolution escaped its immutable snapshot.');",
  '  }',
  '});',
  '',
].join('\n');

type SpawnChild = typeof spawn;

/** Bounds and process environment for one child-process invocation. */
export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  /** The immutable CLI target this spawn measures; workspace `dist` is used when absent. */
  readonly target?: CliTarget;
  readonly timeoutMs?: number;
  /** Test-only process creation seam. */
  readonly spawnChild?: SpawnChild;
  /** Test-only process inventory seam. */
  readonly processSnapshot?: ProcessSnapshot;
  /** Test-only terminal cleanup seam. */
  readonly terminateProcessTree?: () => Promise<void>;
}

/**
 * The one immutable CLI target constructed per invocation. `command` is always
 * this process's Node executable; `entrypoint` identifies the operator-selected
 * source and installed targets execute a guarded private snapshot. Every
 * `--version` / `init` / `graph` / MCP spawn threads this same target so the whole
 * evaluation measures a single, identified CLI build.
 */
interface CliTargetBase {
  readonly command: string;
  readonly entrypoint: string;
  readonly executionPrelude: readonly string[];
}

/** Complete filesystem metadata pinned for an installed-target node. */
export interface CliTargetFilesystemIdentity {
  readonly changeTimeNanoseconds: string;
  readonly device: string;
  readonly groupId: string;
  readonly inode: string;
  readonly linkCount: string;
  readonly mode: string;
  readonly modificationTimeNanoseconds: string;
  readonly sizeBytes: string;
  readonly userId: string;
}

/** Filesystem identity and content digest pinned for one installed entrypoint. */
export interface CliTargetEntrypointIdentity extends CliTargetFilesystemIdentity {
  readonly sha256: string;
}

/** One exact node in the guarded private dependency-closure snapshot. */
export interface CliTargetSnapshotNodeIdentity extends CliTargetFilesystemIdentity {
  readonly entryNames?: readonly string[];
  readonly kind: 'directory' | 'file' | 'link';
  readonly linkTarget?: string;
  readonly relativePath: string;
  readonly resolvedTarget?: string;
}

export interface InstalledCliTarget extends CliTargetBase {
  readonly entrypointIdentity: CliTargetEntrypointIdentity;
  readonly executionEntrypoint: string;
  readonly packageJsonIdentity: CliTargetEntrypointIdentity;
  readonly packageJsonPath: string;
  readonly packageRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotTreeMetadata: readonly CliTargetSnapshotNodeIdentity[];
  readonly snapshotTreeSha256: string;
  readonly source: 'installed';
}

export interface WorkspaceCliTarget extends CliTargetBase {
  readonly entrypointIdentity?: never;
  readonly source: 'workspace';
}

export type CliTarget = InstalledCliTarget | WorkspaceCliTarget;

/** Captured, bounded outcome of one child-process invocation. */
export interface SpawnResult {
  /**
   * Decision evidence behind the descendant-containment verdict (absent on
   * Windows-rejected/pre-tracking failures). A clean result that later proves
   * wrong — e.g. an intermittent CI-only orphan leak — carries the sampler
   * inputs (`samples`, `rootObserved`, `tracked`, `reliable`) instead of an
   * unexplained missing `error`.
   */
  readonly containment?: ProcessTreeSummary;
  readonly durationMs: number;
  readonly error?: string;
  readonly exitCode: number | null;
  readonly outputLimitExceeded: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

/** Signals a missing local prerequisite that the operator can remedy. */
export class HarnessPrerequisiteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HarnessPrerequisiteError';
  }
}

function bufferedUtf8(chunks: readonly Buffer[], totalBytes: number): string {
  if (totalBytes === 0) return '';
  const combined = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) offset += chunk.copy(combined, offset);
  if (offset !== totalBytes) {
    throw new Error('Captured child-process output did not match its bounded byte count.');
  }
  return combined.toString('utf8');
}

function boundedFailureDetail(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    detail
      .replace(/[\r\n\t]+/gu, ' ')
      .trim()
      .slice(0, 512) || 'unknown failure'
  );
}

/** The package's sole child-process implementation, with time and output bounds. */
export function spawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError('timeoutMs must be a positive safe integer'));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new RangeError('maxOutputBytes must be a positive safe integer'));
  }
  if (process.platform === 'win32') {
    return Promise.reject(
      new HarnessPrerequisiteError(
        'Agent-eval requires POSIX process-group cleanup; Windows Job Object containment is unavailable.',
      ),
    );
  }

  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    const spawnChildOption = options.spawnChild;
    const child = (spawnChildOption ?? spawn)(command, [...args], {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processTree =
      child.pid === undefined
        ? undefined
        : retainPosixProcessTree(child, process.platform, {
            ...(options.processSnapshot === undefined
              ? {}
              : { snapshotProcesses: options.processSnapshot }),
          });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let error: string | undefined;
    let outputLimitExceeded = false;
    let resolved = false;
    let rootExitCode: number | null = null;
    let rootSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let terminating = false;
    let forceSettlementTimer: NodeJS.Timeout | undefined;
    let terminationPromise: Promise<void> | undefined;

    const delay = (milliseconds: number): Promise<void> =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      });

    const waitForTreeExit = async (): Promise<boolean> => {
      if (processTree === undefined) return true;
      const deadline = Date.now() + KILL_SETTLE_MS;
      while (processTreeIsAlive(processTree) && Date.now() < deadline) {
        await delay(25);
      }
      return !processTreeIsAlive(processTree);
    };

    const escalate = async (): Promise<void> => {
      if (processTree === undefined) {
        try {
          child.kill('SIGTERM');
        } catch {
          // A command that never spawned has no process tree to clean up.
        }
        return;
      }
      signalProcessTree(processTree, 'SIGTERM');
      await delay(KILL_GRACE_MS);
      if (processTreeIsAlive(processTree)) signalProcessTree(processTree, 'SIGKILL');
      if (!(await waitForTreeExit())) {
        error ??= 'Child process tree did not terminate after bounded SIGTERM/SIGKILL cleanup.';
      }
    };

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (resolved) return;
      let capturedStdout = '';
      let capturedStderr = '';
      try {
        capturedStdout = bufferedUtf8(stdout, stdoutBytes);
        capturedStderr = bufferedUtf8(stderr, stderrBytes);
      } catch (settlementError) {
        error ??= `Child process output settlement failed: ${boundedFailureDetail(settlementError)}.`;
      }
      // Mark resolved only after every potentially throwing output reconstruction
      // has completed. The fallback above deliberately returns empty captures with
      // an explicit degraded error instead of leaving this Promise pending forever.
      resolved = true;
      clearTimeout(timeout);
      if (forceSettlementTimer !== undefined) clearTimeout(forceSettlementTimer);
      if (processTree !== undefined) stopProcessTreeTracking(processTree);
      resolveResult({
        ...(processTree === undefined ? {} : { containment: processTreeSummary(processTree) }),
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(error === undefined ? {} : { error }),
        exitCode,
        outputLimitExceeded,
        signal,
        stderr: capturedStderr,
        stdout: capturedStdout,
        timedOut,
      });
    };

    // Escalation latch, extracted so the settlement path is ACYCLIC (plan 09
    // Task 8.6): forceSettle joins/starts termination through this leaf
    // instead of re-entering terminate — whose ensureForceSettlement arm
    // schedules forceSettle, which previously closed the repo's one
    // architecture.cycle. (When the timer fires, re-arming it was a no-op
    // anyway, so beginTermination alone is semantics-identical here.)
    const retainTerminationFailure = (terminationError: unknown): void => {
      error ??= `Child process cleanup failed: ${boundedFailureDetail(terminationError)}.`;
    };

    const beginTermination = (): void => {
      if (terminating) return;
      terminating = true;
      const terminateProcessTree = options.terminateProcessTree ?? escalate;
      // Invoke through an already-observed promise so both synchronous throws
      // and rejected cleanup promises are classified in the same turn. Waiting
      // until `close` is too late: Node may already report a fast rejection as
      // unhandled and the harness would contaminate its own run.
      terminationPromise = Promise.resolve()
        .then(terminateProcessTree)
        .catch(retainTerminationFailure);
    };

    const forceSettle = async (): Promise<void> => {
      error ??=
        'Child process stdio did not settle after root exit; an unobserved detached descendant may remain.';
      beginTermination();
      try {
        await (terminationPromise ?? Promise.resolve());
      } catch (terminationError) {
        // Defensive for a future termination implementation that replaces the
        // normalized promise after beginTermination.
        retainTerminationFailure(terminationError);
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch (streamError) {
        error ??= `Child process stream cleanup failed: ${boundedFailureDetail(streamError)}.`;
      }
      settle(rootExitCode, rootSignal);
    };

    const settleForcedFailure = (settlementError: unknown): void => {
      error ??= `Child process forced settlement failed: ${boundedFailureDetail(settlementError)}.`;
      settle(rootExitCode, rootSignal);
    };

    const ensureForceSettlement = (): void => {
      forceSettlementTimer ??= setTimeout(() => {
        void forceSettle().catch(settleForcedFailure);
      }, FORCE_SETTLE_MS);
    };

    const terminate = (): void => {
      if (terminating) return;
      beginTermination();
      ensureForceSettlement();
    };

    const enforcePostExitCleanup = (): void => {
      if (terminating || processTree === undefined) return;
      if (!processTreeTrackingReliable(processTree)) {
        error ??=
          'Child process descendant observation became unavailable; cleanup of unobserved descendants cannot be verified.';
        terminate();
        return;
      }
      if (processTreeIsAlive(processTree)) {
        error ??= 'Child process exited while leaving a surviving descendant process.';
        terminate();
      }
    };

    const capture = (target: Buffer[], chunk: Buffer): number => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      let retainedBytes = 0;
      if (remaining > 0) {
        const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(retained);
        retainedBytes = retained.byteLength;
        capturedBytes += retainedBytes;
      }
      if (chunk.byteLength > remaining) {
        outputLimitExceeded = true;
        terminate();
      }
      return retainedBytes;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (processTree !== undefined) sampleProcessTreeIfDue(processTree);
      stdoutBytes += capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (processTree !== undefined) sampleProcessTreeIfDue(processTree);
      stderrBytes += capture(stderr, chunk);
    });
    child.on('error', (spawnError) => {
      error = spawnError.message;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    child.once('exit', (exitCode, signal) => {
      rootExitCode = exitCode;
      rootSignal = signal;
      clearTimeout(timeout);
      if (processTree !== undefined) sampleProcessTree(processTree);
      enforcePostExitCleanup();
      ensureForceSettlement();
    });

    child.on('close', (exitCode, signal) => {
      if (processTree !== undefined) sampleProcessTree(processTree);
      enforcePostExitCleanup();
      void (terminationPromise ?? Promise.resolve()).then(
        () => settle(exitCode, signal),
        (terminationError: unknown) => {
          retainTerminationFailure(terminationError);
          settle(exitCode, signal);
        },
      );
    });
  });
}

/** Compute the workspace-built CLI path from this module location (no existence check). */
export function workspaceCliDistPath(): string {
  return fileURLToPath(new URL('../../../cli/dist/index.js', import.meta.url));
}

/**
 * Resolve the built CLI from both src/runner and dist/runner module locations.
 *
 * @throws {HarnessPrerequisiteError} When the built CLI entrypoint does not exist.
 */
export function resolveCliDist(): string {
  const cliDist = workspaceCliDistPath();
  if (!existsSync(cliDist)) {
    throw new HarnessPrerequisiteError(
      `Built OpenSIP CLI is missing at ${cliDist}; run pnpm build before agent-eval.`,
    );
  }
  return cliDist;
}

const JS_ENTRYPOINT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

function isJsEntrypointPath(path: string): boolean {
  return JS_ENTRYPOINT_EXTENSIONS.has(extname(path).toLowerCase());
}

interface InspectedInstalledEntrypoint {
  readonly identity: CliTargetEntrypointIdentity;
  readonly packageJsonIdentity: CliTargetEntrypointIdentity;
  readonly packageJsonPath: string;
  readonly packageRoot: string;
  readonly realPath: string;
}

interface InspectedInstalledFile {
  readonly bytes?: Buffer;
  readonly identity: CliTargetEntrypointIdentity;
  readonly realPath: string;
}

interface InspectedInstalledFileMetadata {
  readonly identity: CliTargetFilesystemIdentity;
  readonly realPath: string;
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function filesystemIdentityFor(stats: BigIntStats): CliTargetFilesystemIdentity {
  return Object.freeze({
    changeTimeNanoseconds: stats.ctimeNs.toString(),
    device: stats.dev.toString(),
    groupId: stats.gid.toString(),
    inode: stats.ino.toString(),
    linkCount: stats.nlink.toString(),
    mode: stats.mode.toString(),
    modificationTimeNanoseconds: stats.mtimeNs.toString(),
    sizeBytes: stats.size.toString(),
    userId: stats.uid.toString(),
  });
}

function identityFor(stats: BigIntStats, sha256: string): CliTargetEntrypointIdentity {
  return Object.freeze({ ...filesystemIdentityFor(stats), sha256 });
}

function readAndHashOpenFile(
  descriptor: number,
  expectedBytes: number,
  maxBytes: number,
  description: string,
  captureBytes: boolean,
): { readonly bytes?: Buffer; readonly sha256: string } {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new HarnessPrerequisiteError(`The ${description} has an invalid byte size.`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const captured = captureBytes ? Buffer.allocUnsafe(expectedBytes) : undefined;
  let totalBytes = 0;
  let bytesRead: number;
  do {
    bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
    const previousBytes = totalBytes;
    totalBytes += bytesRead;
    if (totalBytes > expectedBytes || totalBytes > maxBytes) {
      throw new HarnessPrerequisiteError(
        `The ${description} exceeds the ${String(maxBytes)} byte limit.`,
      );
    }
    if (bytesRead > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (captured !== undefined) chunk.copy(captured, previousBytes);
    }
  } while (bytesRead > 0);
  if (totalBytes !== expectedBytes) {
    throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
  }
  return {
    ...(captured === undefined ? {} : { bytes: captured }),
    sha256: hash.digest('hex'),
  };
}

export interface InstalledEntrypointOpenFlagConstants {
  readonly O_NONBLOCK?: number;
  readonly O_NOFOLLOW?: number;
  readonly O_RDONLY: number;
}

/**
 * Resolve fail-closed entrypoint-open flags for one platform. POSIX must expose
 * O_NOFOLLOW and O_NONBLOCK; the latter keeps a misidentified FIFO/device from
 * blocking even if it is swapped after the pre-open lstat. Windows relies on
 * its read-only handle plus the surrounding lstat/open/fstat/path-identity
 * checks because Node does not expose the native reparse-point flag.
 */
export function installedEntrypointOpenFlags(
  platform: NodeJS.Platform,
  fsConstants: InstalledEntrypointOpenFlagConstants,
): number {
  if (!Number.isSafeInteger(fsConstants.O_RDONLY) || fsConstants.O_RDONLY < 0) {
    throw new HarnessPrerequisiteError(
      'This platform does not expose a usable read-only entrypoint-open flag.',
    );
  }
  if (platform === 'win32') return fsConstants.O_RDONLY;

  const noFollow = fsConstants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === undefined || noFollow === 0) {
    throw new HarnessPrerequisiteError(
      'This platform cannot safely open an installed CLI entrypoint without following links.',
    );
  }
  const nonBlock = fsConstants.O_NONBLOCK;
  if (!Number.isSafeInteger(nonBlock) || nonBlock === undefined || nonBlock === 0) {
    throw new HarnessPrerequisiteError(
      'This platform cannot safely open an installed CLI entrypoint without blocking.',
    );
  }
  return fsConstants.O_RDONLY | noFollow | nonBlock;
}

function pathStillNamesOpenedFile(
  rawPath: string,
  realPath: string,
  descriptorStats: BigIntStats,
): boolean {
  const pathLinkStats = lstatSync(realPath);
  const pathStats = statSync(realPath, { bigint: true });
  return (
    !pathLinkStats.isSymbolicLink() &&
    pathStats.isFile() &&
    sameNode(descriptorStats, pathStats) &&
    realpathSync(rawPath) === realPath
  );
}

function inspectInstalledRegularFile(options: {
  readonly allowRawSymlink: boolean;
  readonly captureBytes: boolean;
  readonly description: string;
  readonly maxBytes: number;
  readonly rawPath: string;
}): InspectedInstalledFile {
  const { allowRawSymlink, captureBytes, description, maxBytes, rawPath } = options;
  let rawStats;
  try {
    rawStats = lstatSync(rawPath);
  } catch {
    throw new HarnessPrerequisiteError(`The ${description} is not accessible.`);
  }
  if (
    (!allowRawSymlink && rawStats.isSymbolicLink()) ||
    (!rawStats.isSymbolicLink() && !rawStats.isFile())
  ) {
    throw new HarnessPrerequisiteError(`The ${description} is not a regular file.`);
  }

  let realPath: string;
  try {
    realPath = realpathSync(rawPath);
  } catch {
    throw new HarnessPrerequisiteError(`The ${description} could not be resolved.`);
  }
  let descriptor: number | undefined;
  try {
    const canonicalStats = lstatSync(realPath);
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isFile()) {
      throw new HarnessPrerequisiteError(`The ${description} is not a regular file.`);
    }
    // POSIX opens the canonical leaf without following and without blocking.
    // Windows uses a read-only handle; on every platform, descriptor/path
    // identity checks on both sides of hashing detect substitutions.
    descriptor = openSync(realPath, installedEntrypointOpenFlags(process.platform, constants));
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStats.isFile() ||
      !pathStillNamesOpenedFile(rawPath, realPath, descriptorStats)
    ) {
      throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
    }
    if (descriptorStats.size > BigInt(maxBytes)) {
      throw new HarnessPrerequisiteError(
        `The ${description} exceeds the ${String(maxBytes)} byte limit.`,
      );
    }
    const content = readAndHashOpenFile(
      descriptor,
      Number(descriptorStats.size),
      maxBytes,
      description,
      captureBytes,
    );
    const finalStats = fstatSync(descriptor, { bigint: true });
    if (
      !sameSnapshotNodeIdentity(descriptorStats, finalStats) ||
      !pathStillNamesOpenedFile(rawPath, realPath, finalStats)
    ) {
      throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
    }
    return Object.freeze({
      ...(content.bytes === undefined ? {} : { bytes: content.bytes }),
      identity: identityFor(finalStats, content.sha256),
      realPath,
    });
  } catch (error) {
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError(`The ${description} could not be inspected.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Inspect one canonical installed-target leaf without reading its contents.
 * The descriptor and both path observations must continue to name the same
 * regular node, so a boundary check remains fail-closed across rename, link,
 * type, permission, ownership, size, and timestamp changes.
 */
function inspectInstalledRegularFileMetadata(options: {
  readonly description: string;
  readonly maxBytes: number;
  readonly rawPath: string;
}): InspectedInstalledFileMetadata {
  const { description, maxBytes, rawPath } = options;
  let descriptor: number | undefined;
  try {
    const rawStats = lstatSync(rawPath, { bigint: true });
    if (rawStats.isSymbolicLink() || !rawStats.isFile()) {
      throw new HarnessPrerequisiteError(`The ${description} is not a regular file.`);
    }
    const realPath = realpathSync(rawPath);
    if (realPath !== rawPath) {
      throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
    }
    descriptor = openSync(realPath, installedEntrypointOpenFlags(process.platform, constants));
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStats.isFile() ||
      descriptorStats.size > BigInt(maxBytes) ||
      !pathStillNamesOpenedFile(rawPath, realPath, descriptorStats)
    ) {
      throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
    }
    const finalStats = fstatSync(descriptor, { bigint: true });
    const finalPathStats = lstatSync(realPath, { bigint: true });
    if (
      !sameSnapshotNodeIdentity(descriptorStats, finalStats) ||
      !sameSnapshotNodeIdentity(finalStats, finalPathStats) ||
      !pathStillNamesOpenedFile(rawPath, realPath, finalStats)
    ) {
      throw new HarnessPrerequisiteError(`The ${description} changed while it was inspected.`);
    }
    return Object.freeze({
      identity: filesystemIdentityFor(finalStats),
      realPath,
    });
  } catch (error) {
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError(`The ${description} could not be inspected.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function installedPackageRootFor(entrypointRealPath: string): string {
  let current = dirname(entrypointRealPath);
  for (let depth = 0; depth < MAX_PACKAGE_ANCESTORS; depth += 1) {
    const parent = dirname(current);
    if (basename(current) === 'opensip-cli' && basename(parent) === 'node_modules') {
      return current;
    }
    if (parent === current) break;
    current = parent;
  }
  throw new HarnessPrerequisiteError(
    'The installed CLI entrypoint is not under a node_modules/opensip-cli package root.',
  );
}

function binEntrypointFromManifest(manifest: unknown): string | undefined {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    return undefined;
  const bin = (manifest as { readonly bin?: unknown }).bin;
  if (typeof bin === 'string') return bin;
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return undefined;
  if (!Object.hasOwn(bin, 'opensip')) return undefined;
  const opensip = (bin as { readonly opensip?: unknown }).opensip;
  return typeof opensip === 'string' ? opensip : undefined;
}

function parseInstalledPackageManifest(bytes: Buffer): {
  readonly binEntrypoint: string;
  readonly name: string;
  readonly type: 'commonjs' | 'module';
} {
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new HarnessPrerequisiteError('The installed opensip-cli package.json is not valid JSON.');
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new HarnessPrerequisiteError('The installed opensip-cli package.json is not an object.');
  }
  const name = (manifest as { readonly name?: unknown }).name;
  if (name !== 'opensip-cli') {
    throw new HarnessPrerequisiteError(
      'The installed CLI package.json must declare the exact package name "opensip-cli".',
    );
  }
  const binEntrypoint = binEntrypointFromManifest(manifest);
  if (
    binEntrypoint === undefined ||
    binEntrypoint.length === 0 ||
    hasControlCharacter(binEntrypoint)
  ) {
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package.json must declare a usable bin.opensip path.',
    );
  }
  const declaredType = (manifest as { readonly type?: unknown }).type;
  const type = declaredType === 'module' ? 'module' : 'commonjs';
  return { binEntrypoint, name, type };
}

function resolveDeclaredEntrypoint(packageRoot: string, binEntrypoint: string): string {
  if (
    isAbsolute(binEntrypoint) ||
    binEntrypoint.includes('\\') ||
    binEntrypoint.split('/').includes('..')
  ) {
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package.json bin entrypoint must be package-relative.',
    );
  }
  if (!isJsEntrypointPath(binEntrypoint)) {
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package.json bin entrypoint must be a .js, .mjs, or .cjs file.',
    );
  }
  const declaredPath = resolve(packageRoot, binEntrypoint);
  if (!isWithinRoot(packageRoot, declaredPath)) {
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package.json bin entrypoint escapes its package root.',
    );
  }
  try {
    const realPath = realpathSync(declaredPath);
    if (!isWithinRoot(packageRoot, realPath)) {
      throw new HarnessPrerequisiteError(
        'The installed opensip-cli package.json bin entrypoint escapes its package root.',
      );
    }
    return realPath;
  } catch (error) {
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package.json bin entrypoint is not accessible.',
    );
  }
}

function inspectPackageJson(packageJsonPath: string): InspectedInstalledFile {
  return inspectInstalledRegularFile({
    allowRawSymlink: false,
    captureBytes: true,
    description: 'installed opensip-cli package.json',
    maxBytes: MAX_INSTALLED_PACKAGE_JSON_BYTES,
    rawPath: packageJsonPath,
  });
}

function inspectInstalledEntrypoint(rawPath: string): InspectedInstalledEntrypoint {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || hasControlCharacter(rawPath)) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint value is not a usable path.');
  }
  if (!isAbsolute(rawPath)) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint must be an absolute path.');
  }
  if (!isJsEntrypointPath(rawPath)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint must be a .js, .mjs, or .cjs file.',
    );
  }
  let entrypointRealPath: string;
  try {
    entrypointRealPath = realpathSync(rawPath);
  } catch {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint could not be resolved.');
  }
  if (!isJsEntrypointPath(entrypointRealPath)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint must resolve to a .js, .mjs, or .cjs file.',
    );
  }

  const packageRoot = installedPackageRootFor(entrypointRealPath);
  if (realpathSync(packageRoot) !== packageRoot || !isWithinRoot(packageRoot, entrypointRealPath)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint escapes its opensip-cli package root.',
    );
  }
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = inspectPackageJson(packageJsonPath);
  if (packageJson.bytes === undefined) {
    throw new HarnessPrerequisiteError('The installed opensip-cli package.json could not be read.');
  }
  const manifest = parseInstalledPackageManifest(packageJson.bytes);
  const declaredRealPath = resolveDeclaredEntrypoint(packageRoot, manifest.binEntrypoint);
  if (declaredRealPath !== entrypointRealPath) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint is not the bin declared by opensip-cli/package.json.',
    );
  }

  const entrypoint = inspectInstalledRegularFile({
    allowRawSymlink: true,
    captureBytes: true,
    description: 'installed CLI entrypoint',
    maxBytes: MAX_INSTALLED_ENTRYPOINT_BYTES,
    rawPath,
  });
  const finalPackageJson = inspectPackageJson(packageJsonPath);
  if (
    entrypoint.realPath !== declaredRealPath ||
    finalPackageJson.realPath !== packageJson.realPath ||
    !sameEntrypointIdentity(finalPackageJson.identity, packageJson.identity) ||
    realpathSync(packageRoot) !== packageRoot ||
    resolveDeclaredEntrypoint(packageRoot, manifest.binEntrypoint) !== entrypoint.realPath
  ) {
    throw new HarnessPrerequisiteError(
      'The installed opensip-cli package changed while it was being inspected.',
    );
  }
  if (entrypoint.bytes === undefined) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint could not be read.');
  }
  return Object.freeze({
    identity: entrypoint.identity,
    packageJsonIdentity: finalPackageJson.identity,
    packageJsonPath: finalPackageJson.realPath,
    packageRoot,
    realPath: entrypoint.realPath,
  });
}

function sameFilesystemIdentity(
  left: CliTargetFilesystemIdentity,
  right: CliTargetFilesystemIdentity,
): boolean {
  return (
    left.changeTimeNanoseconds === right.changeTimeNanoseconds &&
    left.device === right.device &&
    left.groupId === right.groupId &&
    left.inode === right.inode &&
    left.linkCount === right.linkCount &&
    left.mode === right.mode &&
    left.modificationTimeNanoseconds === right.modificationTimeNanoseconds &&
    left.sizeBytes === right.sizeBytes &&
    left.userId === right.userId
  );
}

function sameEntrypointIdentity(
  left: CliTargetEntrypointIdentity,
  right: CliTargetEntrypointIdentity,
): boolean {
  return sameFilesystemIdentity(left, right) && left.sha256 === right.sha256;
}

/**
 * Validate an operator-supplied installed CLI entrypoint and resolve its realpath.
 * Accepts ONLY the regular, readable, absolute JS bin declared by an installed
 * `node_modules/opensip-cli/package.json`; rejects standalone JS, `.cmd` / shell
 * shims, package escapes, control characters, oversized files, and non-regular
 * nodes. Both manifest and entrypoint are descriptor-checked before and after a
 * bounded SHA-256 pass; shim text is never parsed or trusted.
 *
 * @throws {HarnessPrerequisiteError} When the path is not a usable JS bin entrypoint.
 */
export function validateInstalledEntrypoint(rawPath: string): string {
  return inspectInstalledEntrypoint(rawPath).realPath;
}

interface SnapshotFileObservation {
  readonly identity: CliTargetEntrypointIdentity;
  readonly sourcePath: string;
}

interface SnapshotDirectoryObservation {
  readonly entryNames: readonly string[];
  readonly sourcePath: string;
}

interface SnapshotDependencyBinding {
  readonly dependencyName: string;
  readonly packageRoot: string;
  readonly resolvedRoot: string;
}

interface SnapshotState {
  copiedBytes: number;
  copiedFiles: number;
  readonly dependencyBindings: SnapshotDependencyBinding[];
  readonly directories: SnapshotDirectoryObservation[];
  readonly files: SnapshotFileObservation[];
  readonly installBoundary: string;
  readonly packageDestinations: Map<string, string>;
  packageCount: number;
  readonly storeRoot: string;
}

interface RuntimeDependency {
  readonly name: string;
  readonly optional: boolean;
}

function parsePackageObject(bytes: Buffer, description: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new HarnessPrerequisiteError(`The ${description} is not valid JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessPrerequisiteError(`The ${description} is not an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringRecord(
  value: unknown,
  fieldName: 'dependencies' | 'optionalDependencies' | 'peerDependencies',
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessPrerequisiteError(
      `An installed package ${fieldName} field must be an object of string values.`,
    );
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new HarnessPrerequisiteError(
      `An installed package ${fieldName} field must contain only string values.`,
    );
  }
  return Object.fromEntries(entries);
}

function optionalPeerNames(manifest: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const metadata = manifest.peerDependenciesMeta;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    return new Set();
  return new Set(
    Object.entries(metadata)
      .filter(([, value]) => {
        return (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          (value as { readonly optional?: unknown }).optional === true
        );
      })
      .map(([name]) => name),
  );
}

function usableDependencyName(name: string): boolean {
  if (name.length === 0 || hasControlCharacter(name) || name.includes('\\')) return false;
  const parts = name.split('/');
  if (name.startsWith('@')) {
    return (
      parts.length === 2 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
    );
  }
  return parts.length === 1 && parts[0] !== '.' && parts[0] !== '..';
}

function runtimeDependencies(
  manifest: Readonly<Record<string, unknown>>,
): readonly RuntimeDependency[] {
  const dependencies = stringRecord(manifest.dependencies, 'dependencies');
  const optionalDependencies = stringRecord(manifest.optionalDependencies, 'optionalDependencies');
  const peerDependencies = stringRecord(manifest.peerDependencies, 'peerDependencies');
  const optionalPeers = optionalPeerNames(manifest);
  const byName = new Map<string, boolean>();
  for (const name of Object.keys(dependencies)) byName.set(name, false);
  for (const name of Object.keys(optionalDependencies)) {
    if (!byName.has(name)) byName.set(name, true);
  }
  for (const name of Object.keys(peerDependencies)) {
    if (!byName.has(name)) byName.set(name, optionalPeers.has(name));
  }
  const result = [...byName].map(([name, optional]) => ({ name, optional }));
  if (result.some((dependency) => !usableDependencyName(dependency.name))) {
    throw new HarnessPrerequisiteError(
      'An installed package declares an unusable dependency name.',
    );
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function dependencyPath(root: string, dependencyName: string): string {
  return join(root, 'node_modules', ...dependencyName.split('/'));
}

function packageInstallBoundary(packageRoot: string): string {
  let current = dirname(packageRoot);
  for (let depth = 0; depth < MAX_PACKAGE_ANCESTORS; depth += 1) {
    if (basename(current) === 'node_modules') return dirname(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new HarnessPrerequisiteError(
    'An installed package is not contained by a node_modules installation root.',
  );
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  return candidate === root || isWithinRoot(root, candidate);
}

function inspectSnapshotPackageJson(packageRoot: string): InspectedInstalledFile {
  return inspectInstalledRegularFile({
    allowRawSymlink: false,
    captureBytes: true,
    description: 'installed dependency package.json',
    maxBytes: MAX_INSTALLED_PACKAGE_JSON_BYTES,
    rawPath: join(packageRoot, 'package.json'),
  });
}

function inspectDependencyCandidate(
  candidate: string,
  dependencyName: string,
  installBoundary: string,
): string | undefined {
  if (!isWithinRoot(installBoundary, candidate)) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} escapes its installation root.`,
    );
  }
  let candidateStats;
  try {
    candidateStats = lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} could not be inspected.`,
    );
  }
  if (!candidateStats.isDirectory() && !candidateStats.isSymbolicLink()) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} is not a package directory.`,
    );
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(candidate);
  } catch {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} could not be resolved.`,
    );
  }
  if (!isWithinRoot(installBoundary, resolvedRoot)) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} escapes its installation root.`,
    );
  }
  let stats;
  try {
    stats = lstatSync(resolvedRoot);
  } catch {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} could not be inspected.`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} is not a regular package directory.`,
    );
  }
  const manifest = inspectSnapshotPackageJson(resolvedRoot);
  if (manifest.bytes === undefined) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} package.json could not be read.`,
    );
  }
  return resolvedRoot;
}

function resolveDependencyPackageRoot(
  packageRoot: string,
  dependencyName: string,
  installBoundary: string,
): string | undefined {
  if (!isWithinRoot(installBoundary, packageRoot)) {
    throw new HarnessPrerequisiteError(
      `The installed CLI dependency ${dependencyName} escapes its installation root.`,
    );
  }
  let current = packageRoot;
  for (let depth = 0; depth < MAX_PACKAGE_ANCESTORS; depth += 1) {
    if (!isWithinOrEqual(installBoundary, current)) return undefined;
    const resolvedRoot = inspectDependencyCandidate(
      dependencyPath(current, dependencyName),
      dependencyName,
      installBoundary,
    );
    if (resolvedRoot !== undefined) return resolvedRoot;
    if (current === installBoundary) return undefined;
    const parent = dirname(current);
    if (parent === current || !isWithinOrEqual(installBoundary, parent)) return undefined;
    current = parent;
  }
  return undefined;
}

function copySnapshotFile(sourcePath: string, destinationPath: string, state: SnapshotState): void {
  if (state.copiedFiles >= MAX_SNAPSHOT_FILES) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot exceeds its file-count ceiling.',
    );
  }
  const remainingBytes = MAX_SNAPSHOT_BYTES - state.copiedBytes;
  if (remainingBytes <= 0) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot exceeds its byte ceiling.');
  }
  const inspected = inspectInstalledRegularFile({
    allowRawSymlink: false,
    captureBytes: true,
    description: 'installed package file',
    maxBytes: Math.min(MAX_SNAPSHOT_FILE_BYTES, remainingBytes),
    rawPath: sourcePath,
  });
  if (inspected.bytes === undefined) {
    throw new HarnessPrerequisiteError('An installed package file could not be copied.');
  }
  const sourceMode = statSync(inspected.realPath).mode;
  const snapshotMode = (sourceMode & 0o111) === 0 ? 0o400 : 0o500;
  writeFileSync(destinationPath, inspected.bytes, {
    flag: 'wx',
    mode: snapshotMode,
  });
  chmodSync(destinationPath, snapshotMode);
  state.copiedBytes += inspected.bytes.byteLength;
  state.copiedFiles += 1;
  state.files.push(Object.freeze({ identity: inspected.identity, sourcePath }));
}

function copySnapshotDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  state: SnapshotState,
  depth = 0,
): void {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot exceeds its directory-depth ceiling.',
    );
  }
  const stats = lstatSync(sourceDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new HarnessPrerequisiteError(
      'An installed package directory is not a regular directory.',
    );
  }
  const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  state.directories.push(
    Object.freeze({
      entryNames: Object.freeze(entries.map((entry) => entry.name)),
      sourcePath: sourceDirectory,
    }),
  );
  mkdirSync(destinationDirectory, { mode: 0o700 });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      copySnapshotDirectory(sourcePath, destinationPath, state, depth + 1);
    } else if (entry.isFile()) {
      copySnapshotFile(sourcePath, destinationPath, state);
    } else {
      throw new HarnessPrerequisiteError(
        'Installed package snapshots accept only regular files and directories.',
      );
    }
  }
}

function snapshotDependencyLink(packageDestination: string, dependency: string): string {
  const nodeModules = join(packageDestination, 'node_modules');
  mkdirSync(nodeModules, { mode: 0o700, recursive: true });
  const linkPath = join(nodeModules, ...dependency.split('/'));
  mkdirSync(dirname(linkPath), { mode: 0o700, recursive: true });
  return linkPath;
}

function snapshotPackage(packageRoot: string, state: SnapshotState): string {
  const canonicalRoot = realpathSync(packageRoot);
  const existing = state.packageDestinations.get(canonicalRoot);
  if (existing !== undefined) return existing;
  if (state.packageCount >= MAX_SNAPSHOT_PACKAGES) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot exceeds its package ceiling.');
  }
  state.packageCount += 1;
  const destination = join(
    state.storeRoot,
    `package-${String(state.packageCount).padStart(6, '0')}`,
  );
  state.packageDestinations.set(canonicalRoot, destination);

  const inspectedManifest = inspectSnapshotPackageJson(canonicalRoot);
  if (inspectedManifest.bytes === undefined) {
    throw new HarnessPrerequisiteError('An installed dependency package.json could not be read.');
  }
  const manifest = parsePackageObject(inspectedManifest.bytes, 'installed dependency package.json');
  copySnapshotDirectory(canonicalRoot, destination, state);

  for (const dependency of runtimeDependencies(manifest)) {
    const resolvedRoot = resolveDependencyPackageRoot(
      canonicalRoot,
      dependency.name,
      state.installBoundary,
    );
    if (resolvedRoot === undefined) {
      if (dependency.optional) continue;
      throw new HarnessPrerequisiteError(
        `The installed CLI dependency ${dependency.name} could not be resolved for snapshotting.`,
      );
    }
    state.dependencyBindings.push(
      Object.freeze({
        dependencyName: dependency.name,
        packageRoot: canonicalRoot,
        resolvedRoot,
      }),
    );
    const dependencyDestination = snapshotPackage(resolvedRoot, state);
    const linkPath = snapshotDependencyLink(destination, dependency.name);
    const relativeTarget = relative(dirname(linkPath), dependencyDestination);
    symlinkSync(relativeTarget, linkPath, 'dir');
  }
  return destination;
}

function verifySnapshotSources(state: SnapshotState): void {
  for (const directory of state.directories) {
    const current = readdirSync(directory.sourcePath).sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      current.length !== directory.entryNames.length ||
      current.some((name, index) => name !== directory.entryNames[index])
    ) {
      throw new HarnessPrerequisiteError(
        'An installed package directory changed while its snapshot was built.',
      );
    }
  }
  for (const file of state.files) {
    const current = inspectInstalledRegularFile({
      allowRawSymlink: false,
      captureBytes: false,
      description: 'installed package file',
      maxBytes: MAX_SNAPSHOT_FILE_BYTES,
      rawPath: file.sourcePath,
    });
    if (!sameEntrypointIdentity(current.identity, file.identity)) {
      throw new HarnessPrerequisiteError(
        'An installed package file changed while its snapshot was built.',
      );
    }
  }
  for (const binding of state.dependencyBindings) {
    if (
      resolveDependencyPackageRoot(
        binding.packageRoot,
        binding.dependencyName,
        state.installBoundary,
      ) !== binding.resolvedRoot
    ) {
      throw new HarnessPrerequisiteError(
        'An installed dependency binding changed while its snapshot was built.',
      );
    }
  }
}

function sealSnapshotTree(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || stats.isFile()) return;
  if (!stats.isDirectory()) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot contains a special node.');
  }
  for (const entry of readdirSync(path)) sealSnapshotTree(join(path, entry));
  chmodSync(path, 0o500);
}

function makeSnapshotTreeWritable(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeSnapshotTreeWritable(join(path, entry));
}

interface SnapshotIdentityState {
  bytes: bigint;
  entries: number;
  readonly expectedNodes?: readonly CliTargetSnapshotNodeIdentity[];
  readonly hash?: ReturnType<typeof createHash>;
  nodeIndex: number;
  readonly nodes?: CliTargetSnapshotNodeIdentity[];
  readonly root: string;
}

function sameSnapshotNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameNode(left, right) &&
    left.ctimeNs === right.ctimeNs &&
    left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function recordSnapshotIdentity(state: SnapshotIdentityState, fields: readonly string[]): void {
  state.hash?.update(`${JSON.stringify(fields)}\n`);
}

function sameOptionalStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSnapshotMetadata(
  left: CliTargetSnapshotNodeIdentity,
  right: CliTargetSnapshotNodeIdentity,
): boolean {
  return (
    sameFilesystemIdentity(left, right) &&
    left.kind === right.kind &&
    left.relativePath === right.relativePath &&
    left.linkTarget === right.linkTarget &&
    left.resolvedTarget === right.resolvedTarget &&
    sameOptionalStringArray(left.entryNames, right.entryNames)
  );
}

function snapshotNodeIdentity(
  kind: CliTargetSnapshotNodeIdentity['kind'],
  relativePath: string,
  stats: BigIntStats,
  options: {
    readonly entryNames?: readonly string[];
    readonly linkTarget?: string;
    readonly resolvedTarget?: string;
  } = {},
): CliTargetSnapshotNodeIdentity {
  return Object.freeze({
    ...filesystemIdentityFor(stats),
    ...(options.entryNames === undefined
      ? {}
      : { entryNames: Object.freeze([...options.entryNames]) }),
    kind,
    ...(options.linkTarget === undefined ? {} : { linkTarget: options.linkTarget }),
    relativePath,
    ...(options.resolvedTarget === undefined ? {} : { resolvedTarget: options.resolvedTarget }),
  });
}

function snapshotMetadataFields(node: CliTargetSnapshotNodeIdentity): readonly string[] {
  return [
    node.kind,
    node.relativePath,
    node.device,
    node.inode,
    node.userId,
    node.groupId,
    node.mode,
    node.linkCount,
    node.changeTimeNanoseconds,
    node.modificationTimeNanoseconds,
    node.sizeBytes,
    ...(node.entryNames ?? []),
    ...(node.linkTarget === undefined ? [] : [node.linkTarget]),
    ...(node.resolvedTarget === undefined ? [] : [node.resolvedTarget]),
  ];
}

function observeSnapshotNode(
  state: SnapshotIdentityState,
  node: CliTargetSnapshotNodeIdentity,
): void {
  const expected = state.expectedNodes?.[state.nodeIndex];
  if (
    state.expectedNodes !== undefined &&
    (expected === undefined || !sameSnapshotMetadata(node, expected))
  ) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot changed during verification.');
  }
  state.nodes?.push(node);
  state.nodeIndex += 1;
}

function accountSnapshotEntry(state: SnapshotIdentityState, bytes: bigint): void {
  state.entries += 1;
  state.bytes += bytes;
  if (state.entries > MAX_SNAPSHOT_ENTRIES) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot exceeds its entry-count ceiling.',
    );
  }
  if (state.bytes > BigInt(MAX_SNAPSHOT_BYTES)) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot exceeds its byte ceiling.');
  }
}

function inspectSnapshotFile(
  path: string,
  relativePath: string,
  before: BigIntStats,
  state: SnapshotIdentityState,
): void {
  accountSnapshotEntry(state, before.size);
  const contentSha256 =
    state.hash === undefined
      ? undefined
      : inspectInstalledRegularFile({
          allowRawSymlink: false,
          captureBytes: false,
          description: 'installed CLI snapshot file',
          maxBytes: Math.min(MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_BYTES),
          rawPath: path,
        }).identity.sha256;
  const after = lstatSync(path, { bigint: true });
  if (!sameSnapshotNodeIdentity(before, after)) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot changed during verification.');
  }
  const node = snapshotNodeIdentity('file', relativePath, after);
  observeSnapshotNode(state, node);
  recordSnapshotIdentity(state, [
    ...snapshotMetadataFields(node),
    ...(contentSha256 === undefined ? [] : [contentSha256]),
  ]);
}

function inspectSnapshotLink(
  path: string,
  relativePath: string,
  before: BigIntStats,
  state: SnapshotIdentityState,
): void {
  const linkTarget = readlinkSync(path);
  const resolvedTarget = realpathSync(path);
  const after = lstatSync(path, { bigint: true });
  if (!sameSnapshotNodeIdentity(before, after) || !isWithinRoot(state.root, resolvedTarget)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot link changed or escaped during verification.',
    );
  }
  accountSnapshotEntry(state, after.size);
  const node = snapshotNodeIdentity('link', relativePath, after, {
    linkTarget,
    resolvedTarget: relative(state.root, resolvedTarget),
  });
  observeSnapshotNode(state, node);
  recordSnapshotIdentity(state, snapshotMetadataFields(node));
}

function inspectSnapshotDirectory(
  path: string,
  relativePath: string,
  before: BigIntStats,
  state: SnapshotIdentityState,
  depth: number,
): void {
  accountSnapshotEntry(state, 0n);
  const entryNames = readdirSync(path).sort((left, right) => left.localeCompare(right));
  if (entryNames.length > MAX_SNAPSHOT_ENTRIES) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot exceeds its entry-count ceiling.',
    );
  }
  const node = snapshotNodeIdentity('directory', relativePath, before, {
    entryNames,
  });
  observeSnapshotNode(state, node);
  recordSnapshotIdentity(state, snapshotMetadataFields(node));
  for (const entryName of entryNames) {
    inspectSnapshotIdentityPath(join(path, entryName), state, depth + 1);
  }
  const finalNames = readdirSync(path).sort((left, right) => left.localeCompare(right));
  const after = lstatSync(path, { bigint: true });
  if (
    !sameSnapshotNodeIdentity(before, after) ||
    finalNames.length !== entryNames.length ||
    finalNames.some((name, index) => name !== entryNames[index])
  ) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot changed during verification.');
  }
}

function inspectSnapshotIdentityPath(
  path: string,
  state: SnapshotIdentityState,
  depth: number,
): void {
  if (depth > MAX_SNAPSHOT_DEPTH + 4) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot exceeds its directory-depth ceiling.',
    );
  }
  const relativePath = relative(state.root, path);
  if (relativePath !== '' && !isWithinRoot(state.root, path)) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot path escapes its private root.');
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot became unavailable during verification.',
    );
  }
  if (before.isFile()) {
    inspectSnapshotFile(path, relativePath, before, state);
    return;
  }

  if (before.isSymbolicLink()) {
    inspectSnapshotLink(path, relativePath, before, state);
    return;
  }

  if (!before.isDirectory()) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot contains a special node.');
  }
  inspectSnapshotDirectory(path, relativePath, before, state, depth);
}

interface SnapshotTreeInspection {
  readonly nodes?: readonly CliTargetSnapshotNodeIdentity[];
  readonly sha256?: string;
}

function inspectSnapshotTree(
  snapshotRoot: string,
  options: {
    readonly collectMetadata?: boolean;
    readonly expectedNodes?: readonly CliTargetSnapshotNodeIdentity[];
    readonly hashContents?: boolean;
  },
): SnapshotTreeInspection {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(snapshotRoot);
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot became unavailable during verification.',
    );
  }
  if (canonicalRoot !== snapshotRoot) {
    throw new HarnessPrerequisiteError(
      'The installed CLI snapshot root changed during verification.',
    );
  }
  const state: SnapshotIdentityState = {
    bytes: 0n,
    entries: 0,
    ...(options.expectedNodes === undefined ? {} : { expectedNodes: options.expectedNodes }),
    ...(options.hashContents === true ? { hash: createHash('sha256') } : {}),
    nodeIndex: 0,
    ...(options.collectMetadata === true ? { nodes: [] } : {}),
    root: snapshotRoot,
  };
  inspectSnapshotIdentityPath(snapshotRoot, state, 0);
  if (state.expectedNodes !== undefined && state.nodeIndex !== state.expectedNodes.length) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot changed during verification.');
  }
  return Object.freeze({
    ...(state.nodes === undefined ? {} : { nodes: Object.freeze([...state.nodes]) }),
    ...(state.hash === undefined ? {} : { sha256: state.hash.digest('hex') }),
  });
}

function snapshotTreeIdentity(snapshotRoot: string): {
  readonly nodes: readonly CliTargetSnapshotNodeIdentity[];
  readonly sha256: string;
} {
  const inspected = inspectSnapshotTree(snapshotRoot, {
    collectMetadata: true,
    hashContents: true,
  });
  if (inspected.nodes === undefined || inspected.sha256 === undefined) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot identity is incomplete.');
  }
  return Object.freeze({ nodes: inspected.nodes, sha256: inspected.sha256 });
}

function assertSnapshotTreeMetadataStable(
  snapshotRoot: string,
  expectedNodes: readonly CliTargetSnapshotNodeIdentity[],
): void {
  void inspectSnapshotTree(snapshotRoot, { expectedNodes });
}

function snapshotTreeSha256(snapshotRoot: string): string {
  const inspected = inspectSnapshotTree(snapshotRoot, { hashContents: true });
  if (inspected.sha256 === undefined) {
    throw new HarnessPrerequisiteError('The installed CLI snapshot identity is incomplete.');
  }
  return inspected.sha256;
}

function createInstalledPackageSnapshot(inspected: InspectedInstalledEntrypoint): {
  readonly executionEntrypoint: string;
  readonly resolutionGuard: string;
  readonly snapshotRoot: string;
  readonly snapshotTreeMetadata: readonly CliTargetSnapshotNodeIdentity[];
  readonly snapshotTreeSha256: string;
} {
  const snapshotRoot = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-agent-eval-target-')));
  const storeRoot = join(snapshotRoot, 'store');
  mkdirSync(storeRoot, { mode: 0o700 });
  const state: SnapshotState = {
    copiedBytes: 0,
    copiedFiles: 0,
    dependencyBindings: [],
    directories: [],
    files: [],
    installBoundary: packageInstallBoundary(inspected.packageRoot),
    packageCount: 0,
    packageDestinations: new Map(),
    storeRoot,
  };
  try {
    const packageDestination = snapshotPackage(inspected.packageRoot, state);
    const entrypointRelativePath = relative(inspected.packageRoot, inspected.realPath);
    const executionEntrypoint = join(packageDestination, entrypointRelativePath);
    const snapshotEntrypoint = inspectInstalledRegularFile({
      allowRawSymlink: false,
      captureBytes: false,
      description: 'snapshotted installed CLI entrypoint',
      maxBytes: MAX_INSTALLED_ENTRYPOINT_BYTES,
      rawPath: executionEntrypoint,
    });
    if (snapshotEntrypoint.identity.sha256 !== inspected.identity.sha256) {
      throw new HarnessPrerequisiteError(
        'The installed CLI snapshot entrypoint does not match the verified source bytes.',
      );
    }
    verifySnapshotSources(state);
    const resolutionGuard = join(snapshotRoot, 'resolution-guard.cjs');
    writeFileSync(resolutionGuard, SNAPSHOT_RESOLUTION_GUARD_SOURCE, {
      flag: 'wx',
      mode: 0o400,
    });
    chmodSync(resolutionGuard, 0o400);
    sealSnapshotTree(snapshotRoot);
    const treeIdentity = snapshotTreeIdentity(snapshotRoot);
    return Object.freeze({
      executionEntrypoint,
      resolutionGuard,
      snapshotRoot,
      snapshotTreeMetadata: treeIdentity.nodes,
      snapshotTreeSha256: treeIdentity.sha256,
    });
  } catch (error) {
    makeSnapshotTreeWritable(snapshotRoot);
    rmSync(snapshotRoot, { force: true, recursive: true });
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError(
      `The installed CLI package snapshot could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Construct the immutable CLI target for one invocation. With no entrypoint the
 * workspace-built CLI is targeted (its existence is asserted lazily at spawn /
 * version time). With an entrypoint the package-declared installed JS bin is
 * targeted, with both manifest and entrypoint identity pinned.
 *
 * @throws {HarnessPrerequisiteError} When a supplied installed entrypoint is not a usable JS bin.
 */
export function buildCliTarget(entrypointOption?: string): CliTarget {
  if (entrypointOption === undefined) {
    return Object.freeze({
      command: process.execPath,
      entrypoint: workspaceCliDistPath(),
      executionPrelude: Object.freeze([]),
      source: 'workspace',
    });
  }
  const inspected = inspectInstalledEntrypoint(entrypointOption);
  const snapshot = createInstalledPackageSnapshot(inspected);
  return Object.freeze({
    command: process.execPath,
    entrypoint: inspected.realPath,
    entrypointIdentity: inspected.identity,
    executionEntrypoint: snapshot.executionEntrypoint,
    executionPrelude: Object.freeze(['--require', snapshot.resolutionGuard]),
    packageJsonIdentity: inspected.packageJsonIdentity,
    packageJsonPath: inspected.packageJsonPath,
    packageRoot: inspected.packageRoot,
    snapshotRoot: snapshot.snapshotRoot,
    snapshotTreeMetadata: snapshot.snapshotTreeMetadata,
    snapshotTreeSha256: snapshot.snapshotTreeSha256,
    source: 'installed',
  });
}

/** Remove the private verified-entrypoint snapshot owned by one installed target. */
export function cleanupCliTarget(target: CliTarget): void {
  if (target.source !== 'installed') return;
  try {
    makeSnapshotTreeWritable(target.snapshotRoot);
    rmSync(target.snapshotRoot, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 25,
    });
  } catch {
    // Cleanup is best effort at process shutdown; the private directory contains
    // only verified copies of the already-installed package closure.
  }
}

function assertInstalledSourceMetadataStable(target: InstalledCliTarget): void {
  let entrypoint: InspectedInstalledFileMetadata;
  let packageJson: InspectedInstalledFileMetadata;
  try {
    const packageRootStats = lstatSync(target.packageRoot, { bigint: true });
    if (
      packageRootStats.isSymbolicLink() ||
      !packageRootStats.isDirectory() ||
      realpathSync(target.packageRoot) !== target.packageRoot ||
      dirname(target.packageJsonPath) !== target.packageRoot ||
      !isWithinRoot(target.packageRoot, target.entrypoint)
    ) {
      throw new HarnessPrerequisiteError('The installed CLI package root changed during the run.');
    }
    entrypoint = inspectInstalledRegularFileMetadata({
      description: 'installed CLI entrypoint',
      maxBytes: MAX_INSTALLED_ENTRYPOINT_BYTES,
      rawPath: target.entrypoint,
    });
    packageJson = inspectInstalledRegularFileMetadata({
      description: 'installed opensip-cli package.json',
      maxBytes: MAX_INSTALLED_PACKAGE_JSON_BYTES,
      rawPath: target.packageJsonPath,
    });
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint became unavailable during the run.',
    );
  }
  if (
    entrypoint.realPath !== target.entrypoint ||
    !sameFilesystemIdentity(entrypoint.identity, target.entrypointIdentity) ||
    packageJson.realPath !== target.packageJsonPath ||
    !sameFilesystemIdentity(packageJson.identity, target.packageJsonIdentity)
  ) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint changed during the run.');
  }
}

/**
 * Verify complete source and private-snapshot metadata at an actual target
 * process boundary. Initial construction has already content-hashed the closed
 * dependency snapshot; boundary checks intentionally avoid reading that entire
 * tree again while still failing closed on every path, type, identity,
 * ownership, mode, link-count, size, timestamp, link-target, add, or removal.
 *
 * @throws {HarnessPrerequisiteError} When the installed target changed or became unavailable.
 */
export function assertTargetRealpathStable(target: CliTarget): void {
  if (target.source !== 'installed') return;
  assertInstalledSourceMetadataStable(target);
  try {
    assertSnapshotTreeMetadataStable(target.snapshotRoot, target.snapshotTreeMetadata);
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI private snapshot changed during the run.',
    );
  }
}

/**
 * Re-read the initially pinned source files and complete private closure once,
 * after all measured work, before report evidence is trusted. This final
 * content boundary supplements the frequent complete-metadata checks and
 * preserves the original byte-identity guarantee without rehashing per arm.
 */
export function assertTargetFinalStable(target: CliTarget): void {
  if (target.source !== 'installed') return;
  let current: InspectedInstalledEntrypoint;
  try {
    current = inspectInstalledEntrypoint(target.entrypoint);
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint became unavailable during final verification.',
    );
  }
  if (
    current.realPath !== target.entrypoint ||
    !sameEntrypointIdentity(current.identity, target.entrypointIdentity) ||
    current.packageJsonPath !== target.packageJsonPath ||
    current.packageRoot !== target.packageRoot ||
    !sameEntrypointIdentity(current.packageJsonIdentity, target.packageJsonIdentity)
  ) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint changed before final verification.',
    );
  }
  let currentSnapshotSha256: string;
  try {
    currentSnapshotSha256 = snapshotTreeSha256(target.snapshotRoot);
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI private snapshot changed during the run.',
    );
  }
  if (currentSnapshotSha256 !== target.snapshotTreeSha256) {
    throw new HarnessPrerequisiteError(
      'The installed CLI private snapshot changed before final verification.',
    );
  }
}

/** Spawn the built OpenSIP CLI through the bounded process substrate. */
export async function spawnCli(
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const { target, ...spawnOptions } = options;
  if (target !== undefined) assertTargetRealpathStable(target);
  const command = target?.command ?? process.execPath;
  const entrypoint =
    target?.source === 'installed'
      ? target.executionEntrypoint
      : (target?.entrypoint ?? resolveCliDist());
  const executionPrelude = target?.executionPrelude ?? [];
  try {
    return await spawnProcess(command, [...executionPrelude, entrypoint, ...args], {
      ...spawnOptions,
      env: spawnOptions.env ?? buildDeterministicEnv(),
    });
  } finally {
    if (target !== undefined) assertTargetRealpathStable(target);
  }
}

/** Return a UTF-8-bounded diagnostic suffix without exposing full child output. */
export function tailForDiagnostics(text: string, maxBytes = 2048): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  const marker = Buffer.from(TRUNCATION_MARKER, 'utf8');
  if (maxBytes <= marker.byteLength) return marker.subarray(0, maxBytes).toString('utf8');
  const tailLength = maxBytes - marker.byteLength;
  let tail = bytes.subarray(bytes.byteLength - tailLength).toString('utf8');
  while (Buffer.byteLength(tail, 'utf8') > tailLength) tail = tail.slice(1);
  return `${TRUNCATION_MARKER}${tail}`;
}
