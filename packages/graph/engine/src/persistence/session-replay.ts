import { buildReplaySignals, decodeSessionPayload } from '@opensip-cli/session-store';

import { graphFingerprintStrategy } from '../baseline-strategy.js';

import type {
  RunPresentation,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';

/**
 * Project a stored graph session back into a {@link SignalEnvelope}/{@link RunPresentation}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`, here with `requireFilePath`/`requireViolationCount`/
 * `allowMetadata` — graph findings always carry those); this function owns only
 * graph's projection (`tool: 'graph'`, `category: 'architecture'`, signal id
 * prefix).
 *
 * The replay RENDER path reads only `replay.envelope` + `replay.fidelity` —
 * `graph-command-spec.ts` builds the host `SessionReplayResult` from those
 * (`sessionReplayResult`/`sessionShowJson`). The inner `RunPresentation` `result`
 * is a uniform, render-only carrier and is not on the replay render path.
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
// @graph-ignore-next-line graph:near-duplicate-function-body -- graph and sim replay projections intentionally mirror the shared session payload shape while stamping tool-specific envelopes.
export function graphReplayFromSession(stored: StoredSession): ToolSessionReplay<RunPresentation> {
  const payload = decodeSessionPayload(stored.payload, {
    tool: 'graph',
    requireFilePath: true,
    requireViolationCount: true,
    allowMetadata: true,
  });
  const units: UnitResult[] = payload.checks.map((check) => ({
    slug: check.checkSlug,
    passed: check.passed,
    ...(check.violationCount === undefined ? {} : { violationCount: check.violationCount }),
    durationMs: check.durationMs,
  }));
  const signals = buildReplaySignals({
    stored,
    checks: payload.checks,
    toolPrefix: 'graph',
    category: 'architecture',
    metadata: (finding) => finding.metadata ?? {},
    alwaysIncludeCode: true,
  });
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'graph',
    runId: stored.id,
    createdAt: stored.startedAt,
    ...(stored.recipe === undefined ? {} : { recipe: stored.recipe }),
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: payload.summary,
    },
    units,
    signals,
    baselineIdentity: {
      fingerprintStrategyId: graphFingerprintStrategy.id,
      fingerprintStrategyVersion: graphFingerprintStrategy.version,
    },
  };
  return {
    fidelity: 'projection',
    envelope,
    result: { type: 'run-presentation', tool: 'graph', envelope },
  };
}
