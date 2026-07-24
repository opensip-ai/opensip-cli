/**
 * Process-level last-resort failure net (Plan 00 Phase 3.9).
 *
 * Handles truly escaped uncaughtException / unhandledRejection with a minimal
 * synchronous-safe coded projection. Does not re-enter async reportFailure,
 * logger transports, or cleanup. Install once at the CLI composition root.
 *
 * Both uncaughtException and unhandledRejection force-exit after the minimal
 * write so the process cannot resume with undefined state (Plan 00 consider).
 */

import { normalizeFailure } from '@opensip-cli/core';

let installed = false;

const FATAL_EXIT = 1;

function writeMinimal(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // nowhere else to go
  }
}

function projectFatal(reason: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void {
  try {
    const envelope = normalizeFailure(reason);
    writeMinimal(`opensip: fatal ${kind} [${envelope.code}] ${envelope.message.slice(0, 200)}`);
  } catch {
    writeMinimal(`opensip: fatal ${kind} [CORE.SYSTEM.UNKNOWN_FAILURE]`);
  }
  try {
    process.exitCode = FATAL_EXIT;
  } catch {
    // ignore
  }
}

function forceFatalExit(): void {
  try {
    process.exitCode = FATAL_EXIT;
    // @fitness-ignore-next-line no-local-exit-or-stdout -- Process edge (Plan 00 §4.7): a truly-escaped uncaughtException/unhandledRejection cannot unwind to the top-level boundary, so the last-resort net must synchronously terminate rather than set process.exitCode and resume.
    process.exit(FATAL_EXIT);
  } catch {
    // ignore
  }
}

/**
 * Install non-reentrant last-resort handlers. Idempotent.
 * Does not resume the process after uncaughtException or unhandledRejection.
 */
export function installLastResortFailureNet(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (error) => {
    projectFatal(error, 'uncaughtException');
    forceFatalExit();
  });

  process.on('unhandledRejection', (reason) => {
    projectFatal(reason, 'unhandledRejection');
    forceFatalExit();
  });
}

/** Test-only: reset install flag so a fresh net can be registered. */
export function resetLastResortFailureNetForTests(): void {
  installed = false;
}
