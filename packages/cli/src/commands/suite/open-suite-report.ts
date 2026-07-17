import { planReportOpen, type DeferredReportEffect } from '../../bootstrap/report.js';

import { BUILT_IN_AUDIT_SUITE_NAME } from './built-in-suites.js';

/**
 * Plan the suite's one host-owned report effect without performing I/O.
 *
 * The nested evidence owner executes this effect only after its complete
 * parent/child bundle commits. Audit is always bound to the exact preallocated
 * parent Run identity; it never falls back to "latest".
 */
export function planSuiteReportEffect(input: {
  readonly name: string;
  readonly runId: string;
  readonly opts: Readonly<Record<string, unknown>>;
}): DeferredReportEffect | undefined {
  const plan = planReportOpen({
    openRequested: input.opts.open === true,
    jsonOutput: input.opts.json === true,
  });
  if (plan.status === 'skipped') return;
  return Object.freeze({
    ...plan.effect,
    ...(input.name === BUILT_IN_AUDIT_SUITE_NAME
      ? {
          selection: Object.freeze({
            view: 'change-impact' as const,
            runId: input.runId,
          }),
        }
      : {}),
  });
}
