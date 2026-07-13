import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  readonly timeoutMs?: number;
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

/**
 * Resolve the built CLI from both src/runner and dist/runner module locations.
 *
 * @throws {HarnessPrerequisiteError} When the built CLI entrypoint does not exist.
 */
export function resolveCliDist(): string {
  const cliDist = fileURLToPath(new URL('../../../cli/dist/index.js', import.meta.url));
  if (!existsSync(cliDist)) {
    throw new HarnessPrerequisiteError(
      `Built OpenSIP CLI is missing at ${cliDist}; run pnpm build before agent-eval.`,
    );
  }
  return cliDist;
}

/** Spawn the built OpenSIP CLI through the bounded process substrate. */
export function spawnCli(
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return spawnProcess(process.execPath, [resolveCliDist(), ...args], {
    ...options,
    env: options.env ?? buildDeterministicEnv(),
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
