/**
 * CLEAN fixture — the reviewer-accepted shape: `error.name` used as a METRIC
 * LABEL while the error itself is rethrown untouched.
 *
 * Reduced from the real accepted site
 * `packages/external-tool-adapter/src/run-loop-helpers.ts` (`progressStep`).
 * This file is the precision anchor for the whole check: it contains the exact
 * token (`error.name`) that variant 1 keys on, and it must NOT fire. A detector
 * that matched the token instead of the dataflow would flag it — that is the
 * documented failure mode the reviewers rejected repeatedly ("matched on the
 * identifier, not the semantics").
 *
 * Why it is correct: the progress bridge wants a short, low-cardinality label
 * for the stage that failed; `error.name` is exactly right for that. The
 * failure detail is not lost, because `throw error` on the next line hands the
 * whole value — message, `.code`, `.cause`, stack — to the caller's boundary.
 * Labelling is only a defect when it REPLACES forwarding.
 *
 * Prose check: this comment mentions `error.name` and `catch (error)` several
 * times. Comments are masked before scanning, so none of it is visible to the
 * analyzer.
 */
interface ProgressBridge {
  readonly emit: (event: Record<string, unknown>) => void;
}

export async function progressStep<T>(
  bridge: ProgressBridge | undefined,
  stage: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  bridge?.emit({ kind: 'adapter-stage', stage, status: 'start' });
  const begin = performance.now();
  try {
    const result = await fn();
    bridge?.emit({
      kind: 'adapter-stage',
      stage,
      status: 'done',
      durationMs: Math.max(0, Math.round(performance.now() - begin)),
    });
    return result;
  } catch (error) {
    bridge?.emit({
      kind: 'adapter-stage',
      stage,
      status: 'done',
      detail: error instanceof Error ? error.name : 'error',
      durationMs: Math.max(0, Math.round(performance.now() - begin)),
    });
    throw error;
  }
}

/**
 * Also clean, and deliberately so: a bare `catch {}` best-effort cleanup. It IS
 * a total loss of detail, but it is the idiomatic form for "this may not exist
 * and I do not care", there are hundreds of them in the tree, and flagging the
 * shape wholesale would bury the two findings that matter. Out of scope by
 * design, not by accident.
 */
export function bestEffortCleanup(remove: () => void): void {
  try {
    remove();
  } catch {
    // nothing to release
  }
}

/**
 * Also clean: `String(error)` passes the binding whole and carries the message
 * with it. It may still drop a `.code`, but deciding that needs to know whether
 * a coded error can reach this site — a semantic judgement the check leaves to
 * human review rather than guessing at.
 */
export function summarize(run: () => void, log: (record: Record<string, unknown>) => void): void {
  try {
    run();
  } catch (error) {
    log({ evt: 'adapter.step_failed', reason: String(error) });
  }
}
