/**
 * @fileoverview The substrate's SINGLE subprocess/IO boundary (ADR-0090 §11).
 *
 * `execFile` / `execFileSync` ONLY — NEVER `exec` with a shell string. Args are
 * descriptor-controlled arrays, so a scanner argument can never be interpreted as
 * a shell metacharacter. This module wraps the three IO primitives the substrate
 * needs — PATH lookup (`which`/`where`), the scanner process runner (timeout +
 * output cap), and the version probe — plus the real {@link BinaryResolveDeps}.
 *
 * It is the one file excluded from unit coverage: it runs a real external binary
 * and is exercised end-to-end by each adapter's worker E2E (ADR-0090 D6 Tier 2).
 * Every decision it feeds (resolution, exit modeling, ingest) is pure and covered
 * directly.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { BinaryResolveDeps } from './binary-resolver.js';

/** The captured outcome of a scanner process run. */
export interface ProcessResult {
  /** The exit code (`-1` when the process was killed by the timeout). */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Max captured stdout+stderr bytes before the run is aborted. */
  readonly maxBuffer: number;
}

/**
 * Run a scanner binary with `execFile` (no shell), capturing stdout/stderr and
 * the exit code EVEN on a nonzero exit (a scanner signalling findings via exit
 * code is not an error here — {@link interpretExit} classifies it). Rejects only
 * on a spawn failure (e.g. `ENOENT`); a timeout resolves with `timedOut: true`.
 */
export function runScannerProcess(input: RunProcessInput): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    execFile(
      input.command,
      [...input.args],
      {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: input.maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error === null) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: NodeJS.Signals;
        };
        if (failure.killed === true || failure.signal === 'SIGTERM') {
          resolve({ code: -1, stdout: out, stderr: err, timedOut: true });
          return;
        }
        // A string `code` (`ENOENT`/`EACCES`) is a spawn failure, not an exit code.
        if (typeof failure.code === 'string') {
          reject(
            error instanceof Error
              ? error
              : new Error(`scanner '${input.command}' failed to spawn (${failure.code})`),
          );
          return;
        }
        resolve({
          code: typeof failure.code === 'number' ? failure.code : 1,
          stdout: out,
          stderr: err,
          timedOut: false,
        });
      },
    );
  });
}

export interface ProbeVersionInput {
  readonly path: string;
  readonly versionArgs: readonly string[];
  readonly parse?: (stdout: string) => string;
  readonly timeoutMs: number;
}

/** Probe a binary's version (`execFileSync`, no shell). Returns `undefined` on any failure. */
export function probeBinaryVersion(input: ProbeVersionInput): string | undefined {
  try {
    const stdout = execFileSync(input.path, [...input.versionArgs], {
      encoding: 'utf8',
      timeout: input.timeoutMs,
      windowsHide: true,
    });
    const text = typeof stdout === 'string' ? stdout : String(stdout);
    return (input.parse ?? ((s: string) => s.trim()))(text);
  } catch {
    // intentionally silent: a version probe failure (binary missing, slow, or
    // a non-version output) is a normal "version unknown" — surfaced as
    // undefined, which doctor renders. No logger is available in this pure seam.
    return undefined;
  }
}

/** PATH lookup via `which` (POSIX) / `where` (Windows), no shell. `undefined` if absent. */
export function whichBinary(command: string, platform: NodeJS.Platform): string | undefined {
  const finder = platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [command], { encoding: 'utf8', windowsHide: true });
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    // intentionally silent: a `which`/`where` miss means "not on PATH" — a normal
    // resolution outcome surfaced as undefined (the resolver then reports a
    // not-found with an install hint). No logger in this pure IO seam.
    return undefined;
  }
}

/** The real binary-resolution IO deps (existence check + PATH lookup). */
export const defaultBinaryDeps: BinaryResolveDeps = {
  existsSync: (path) => existsSync(path),
  which: (command, platform) => whichBinary(command, platform),
};
