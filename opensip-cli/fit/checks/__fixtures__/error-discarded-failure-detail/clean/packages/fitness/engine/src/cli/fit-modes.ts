/**
 * CLEAN fixture — the second reviewer-accepted shape: `error.name` logged
 * ALONGSIDE `error.message`, with the error object itself handed to the host
 * failure seam.
 *
 * Reduced from the real accepted site
 * `packages/fitness/engine/src/cli/fit-modes.ts` (the gate-mode baseline catch).
 * Together with the `run-loop-helpers` fixture this pins both legitimate uses of
 * `.name`: as an extra label next to the detail (here), and as a label in front
 * of a rethrow (there).
 *
 * Why it is correct: this is the shape the rule is steering code TOWARD. The
 * failure is narrowed to the two classified cases, `reason: error.message`
 * carries the detail, `errorType: error.name` adds a stable low-cardinality
 * dimension for querying, and `reportFailure({ error })` passes the whole value
 * to the host so the exit-code policy and any `.code` survive. The
 * unclassified case rethrows rather than inventing a bucket — which is exactly
 * what variant 2 asks the graph read views to do.
 */
export class ConfigurationError extends Error {}
export class SystemError extends Error {}

interface CliContext {
  readonly reportFailure: (input: {
    error: unknown;
    message: string;
    log: { evt: string; level: string; data: Record<string, unknown> };
  }) => Promise<void>;
}

declare function runGate(mode: 'save' | 'compare'): Promise<void>;

export async function executeGateMode(cli: CliContext, mode: 'save' | 'compare'): Promise<void> {
  try {
    await runGate(mode);
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof SystemError) {
      await cli.reportFailure({
        error,
        message: `Error: ${error.message}`,
        log: {
          evt: 'cli.gate.baseline_error',
          level: 'warn',
          data: {
            module: 'cli:gate',
            mode,
            errorType: error.name,
            reason: error.message,
          },
        },
      });
      return;
    }
    throw error;
  }
}

/**
 * Also clean: narrowing followed by a rethrow. Variant 2 fires only when the
 * binding is narrowed and then NEVER read again; `throw error` is a read that
 * carries everything forward, so an early return for an expected cancellation
 * is not a finding.
 */
export class CancelledError extends Error {}

export async function readWithCancellation(read: () => Promise<number>): Promise<number | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CancelledError) return null;
    throw error;
  }
}
