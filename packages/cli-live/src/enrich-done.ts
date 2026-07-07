/**
 * Fold a run envelope's 3-way outcome into the live done-data so the compact TTY
 * surface matches the static (pipe) render: the headline reads FAULT when the run
 * faulted, and failed/faulted units surface as attention bullets. The derivation
 * is `contracts.envelopeToResultSummary` — the SAME projection the static
 * `result-to-view` path uses, so the two renderers cannot drift.
 *
 * A tool that returns no envelope keeps its done-data untouched (graceful
 * degradation: headline stays PASS/FAIL, no bullets).
 */

import { envelopeToResultSummary } from '@opensip-cli/contracts';

import type { LiveRunDoneData } from '@opensip-cli/cli-ui';
import type { SignalEnvelope } from '@opensip-cli/contracts';

export function enrichDoneWithEnvelope(
  done: LiveRunDoneData,
  envelope?: SignalEnvelope,
): LiveRunDoneData {
  if (envelope === undefined) return done;
  const attention = envelopeToResultSummary(envelope);
  return {
    ...done,
    summary: { ...done.summary, faulted: envelope.verdict.faulted },
    ...(attention === undefined ? {} : { attention }),
  };
}
