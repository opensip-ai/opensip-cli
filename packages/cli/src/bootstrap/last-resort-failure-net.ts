/**
 * Process-level last-resort failure net (Plan 00 Phase 3.9).
 *
 * Handles truly escaped uncaughtException / unhandledRejection with a minimal
 * synchronous-safe coded projection. Does not re-enter async reportFailure,
 * logger transports, or cleanup. Install once at the CLI composition root.
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

/**
 * Install non-reentrant last-resort handlers. Idempotent.
 * Does not resume the process after uncaughtException.
 */
export function installLastResortFailureNet(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (error) => {
    projectFatal(error, 'uncaughtException');
    // Terminal — do not resume (Node will exit when no other work remains if we exit).
    try {
      process.exit(FATAL_EXIT);
    } catch {
      // ignore
    }
  });

  process.on('unhandledRejection', (reason) => {
    projectFatal(reason, 'unhandledRejection');
    try {
      process.exitCode = FATAL_EXIT;
    } catch {
      // ignore
    }
  });
}
