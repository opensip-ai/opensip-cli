/**
 * VIOLATION fixture — variant 1 (label-only), severity `error`.
 *
 * Reduced from the real confirmed site
 * `packages/cli/src/bootstrap/run-plane.ts` (`executeDeferredReport`, the catch
 * at line 248 in the tree this fixture was cut from). Only the surrounding
 * plumbing is elided; the catch body is byte-for-byte the shape that ships.
 *
 * Why it is a defect: `error.name` is the ONLY thing ever read off the binding.
 * The report effect can fail because the browser opener is missing (ENOENT),
 * because the artifact path is not writable (EACCES), or because the deferred
 * effect timed out — and all three arrive at the user as `errorName: 'Error'`.
 * The message, the `.code` and the `.cause` chain never leave this block, and
 * the same useless label is then forwarded to `onReportEffectFailure`, so the
 * loss is permanent by the time anything is presented.
 */
interface ReportEffect {
  readonly kind: string;
}

interface Deps {
  readonly executeReportEffect?: (effect: ReportEffect) => Promise<void>;
  readonly onReportEffectFailure?: (input: {
    effect: ReportEffect;
    errorName: string;
  }) => Promise<void>;
}

interface Log {
  readonly warn?: (record: Record<string, unknown>) => void;
}

const MODULE_TAG = 'cli:run-plane';

export async function executeDeferredReport(
  deps: Deps,
  log: Log,
  reportEffect: ReportEffect | undefined,
): Promise<void> {
  if (reportEffect === undefined || deps.executeReportEffect === undefined) return;
  try {
    await deps.executeReportEffect(reportEffect);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    log.warn?.({
      evt: 'cli.report.deferred_open_failed',
      module: MODULE_TAG,
      errorName,
    });
    await deps.onReportEffectFailure?.({ effect: reportEffect, errorName });
  }
}
