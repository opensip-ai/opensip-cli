/**
 * egress-plane — the host's effectful-egress plane
 * (host-owned-run-timing Phase 6 §6.1).
 *
 * The composition root owns all outbound delivery (ADR-0011 / ADR-0008): cloud
 * sync via the run's signal sink + `--report-to` SARIF upload, and the
 * SARIF-file sink. Tools never import `@opensip-cli/output`; they call these two
 * `ToolCliContext` seams, which delegate to the existing `deliver-envelope`
 * implementation. Extracted from `buildToolCliContext` so the egress concern has
 * its own narrow, testable home.
 */

import { logger as defaultLogger, type Logger, type ToolCliContext } from '@opensip-cli/core';

import { deliverEnvelope, writeEnvelopeSarif } from './deliver-envelope.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

/** Stable dependencies the egress plane captures. */
export interface EgressPlaneDeps {
  /** The single exit-code write path (from the output plane) — threaded into delivery. */
  readonly setExitCode: (code: number) => void;
  readonly logger?: Logger;
}

/** The egress plane's public surface (the two `ToolCliContext` egress seams). */
export type EgressPlane = Pick<ToolCliContext, 'deliverSignals' | 'writeSarif'>;

export function createEgressPlane(deps: EgressPlaneDeps): EgressPlane {
  const log = deps.logger ?? defaultLogger;
  return {
    // The root owns all effectful egress (ADR-0011 / ADR-0008): cloud sync via
    // the run's signal sink + `--report-to` SARIF upload. Tools call this once
    // per run; `setExitCode` is threaded so a `--report-to` failure on an
    // otherwise-passing run can claim exit 4. The delivery result (what actually
    // shipped / why a leg was skipped) flows back to the caller — the root has
    // already printed any user-facing notice, so callers may ignore it.
    deliverSignals: (envelope, deliverOpts) =>
      deliverEnvelope(envelope as SignalEnvelope, {
        cwd: deliverOpts.cwd,
        reportTo: deliverOpts.reportTo,
        apiKey: deliverOpts.apiKey,
        runFailed: deliverOpts.runFailed,
        setExitCode: deps.setExitCode,
        logger: log,
      }),
    // Root-owned SARIF-file sink (ADR-0011): the one place that formats an
    // envelope to SARIF and writes it to disk, so tools that export SARIF to a
    // file (e.g. `graph sarif-export`) never import `@opensip-cli/output`.
    writeSarif: (envelope, path) => writeEnvelopeSarif(envelope as SignalEnvelope, path),
  };
}
