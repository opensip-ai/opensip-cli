import { buildReplaySignals, decodeSessionPayload } from '@opensip-cli/session-store';

import type {
  RunPresentation,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';

/**
 * Project a stored sim session back into a {@link SignalEnvelope}/{@link RunPresentation}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`); this function owns only sim's projection
 * (`tool: 'sim'`, `category: 'testing'`, signal id prefix).
 *
 * The replay RENDER path reads only `replay.envelope` + `replay.fidelity` (the
 * host builds the shared `SessionReplayResult` from those); the inner
 * `RunPresentation` `result` is a uniform, render-only carrier and is not on the
 * replay render path.
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
export function simReplayFromSession(stored: StoredSession): ToolSessionReplay<RunPresentation> {
  const payload = decodeSessionPayload(stored.payload, {
    tool: 'sim',
    requireViolationCount: true,
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
    toolPrefix: 'sim',
    category: 'testing',
  });
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'sim',
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
  };
  return {
    fidelity: 'projection',
    envelope,
    result: { type: 'run-presentation', tool: 'simulation', envelope },
  };
}
