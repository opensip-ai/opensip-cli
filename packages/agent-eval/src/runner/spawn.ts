import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasControlCharacter } from '../control-text.js';

import { buildDeterministicEnv } from './env.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const TRUNCATION_MARKER = '[output truncated]\n';

/** Bounds and process environment for one child-process invocation. */
export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  /** The immutable CLI target this spawn measures; workspace `dist` is used when absent. */
  readonly target?: CliTarget;
  readonly timeoutMs?: number;
}

/** Which OpenSIP CLI build the harness measures. */
export type CliTargetSource = 'installed' | 'workspace';

/**
 * The one immutable CLI target constructed per invocation. `command` is always
 * this process's Node executable; `entrypoint` is the JS file it runs. Every
 * `--version` / `init` / `graph` / MCP spawn threads this same target so the whole
 * evaluation measures a single, identified CLI build.
 */
export interface CliTarget {
  readonly command: string;
  readonly entrypoint: string;
  readonly source: CliTargetSource;
}

/** Captured, bounded outcome of one child-process invocation. */
export interface SpawnResult {
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

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
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

  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let error: string | undefined;
    let outputLimitExceeded = false;
    let timedOut = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(retained);
        capturedBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) {
        outputLimitExceeded = true;
        terminate();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.on('error', (spawnError) => {
      error = spawnError.message;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveResult({
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(error === undefined ? {} : { error }),
        exitCode,
        outputLimitExceeded,
        signal,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
        timedOut,
      });
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

/**
 * Validate an operator-supplied installed CLI entrypoint and resolve its realpath.
 * Accepts ONLY a regular, readable, absolute JS bin file; rejects `.cmd` / shell
 * shims, control characters, and non-regular nodes. The file's contents are never
 * read or parsed — a shim is rejected structurally, never by trusting its text.
 *
 * @throws {HarnessPrerequisiteError} When the path is not a usable JS bin entrypoint.
 */
export function validateInstalledEntrypoint(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || hasControlCharacter(rawPath)) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint value is not a usable path.');
  }
  if (!isAbsolute(rawPath)) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint must be an absolute path.');
  }
  // A `.cmd` shim or any non-JS name is rejected before touching the filesystem.
  if (!isJsEntrypointPath(rawPath)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint must be a .js, .mjs, or .cjs file.',
    );
  }
  try {
    lstatSync(rawPath);
  } catch {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint is not accessible.');
  }
  // realpath resolves any symlink; the resolved node must itself be a regular JS file.
  let realPath: string;
  try {
    realPath = realpathSync(rawPath);
  } catch {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint could not be resolved.');
  }
  if (!isJsEntrypointPath(realPath)) {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint must resolve to a .js, .mjs, or .cjs file.',
    );
  }
  let stats;
  try {
    stats = statSync(realPath);
  } catch {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint could not be inspected.');
  }
  if (!stats.isFile()) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint must be a regular file.');
  }
  try {
    accessSync(realPath, constants.R_OK);
  } catch {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint is not readable.');
  }
  return realPath;
}

/**
 * Construct the immutable CLI target for one invocation. With no entrypoint the
 * workspace-built CLI is targeted (its existence is asserted lazily at spawn /
 * version time). With an entrypoint the verified installed JS bin is targeted,
 * with `entrypoint` set to its canonical realpath.
 *
 * @throws {HarnessPrerequisiteError} When a supplied installed entrypoint is not a usable JS bin.
 */
export function buildCliTarget(entrypointOption?: string): CliTarget {
  if (entrypointOption === undefined) {
    return Object.freeze({
      command: process.execPath,
      entrypoint: workspaceCliDistPath(),
      source: 'workspace',
    });
  }
  return Object.freeze({
    command: process.execPath,
    entrypoint: validateInstalledEntrypoint(entrypointOption),
    source: 'installed',
  });
}

/**
 * Re-verify that an installed target's realpath is unchanged mid-run. A workspace
 * target's `dist` is our own build (resolved lazily at spawn time and legitimately
 * absent in unit runs), so it is not re-validated here.
 *
 * @throws {HarnessPrerequisiteError} When the installed entrypoint moved, vanished, or is no longer a regular file.
 */
export function assertTargetRealpathStable(target: CliTarget): void {
  if (target.source !== 'installed') return;
  let current: string;
  let stats;
  try {
    current = realpathSync(target.entrypoint);
    stats = statSync(current);
  } catch {
    throw new HarnessPrerequisiteError(
      'The installed CLI entrypoint became unavailable during the run.',
    );
  }
  if (current !== target.entrypoint || !stats.isFile()) {
    throw new HarnessPrerequisiteError('The installed CLI entrypoint changed during the run.');
  }
}

/** Spawn the built OpenSIP CLI through the bounded process substrate. */
export function spawnCli(
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const { target, ...spawnOptions } = options;
  const command = target?.command ?? process.execPath;
  const entrypoint = target?.entrypoint ?? resolveCliDist();
  return spawnProcess(command, [entrypoint, ...args], {
    ...spawnOptions,
    env: spawnOptions.env ?? buildDeterministicEnv(),
  });
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
