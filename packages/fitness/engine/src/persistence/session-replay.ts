import { currentScope, extractPayloadVersion } from '@opensip-cli/core';
import { buildReplaySignals, decodeSessionPayload } from '@opensip-cli/session-store';

import type {
  RunPresentation,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';

/**
 * Project a stored fit session back into a {@link SignalEnvelope}/{@link RunPresentation}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`); this function owns only fit's projection — the
 * envelope vocabulary (`tool: 'fit'`, recipe label) and the per-finding signal
 * shape (`category: 'quality'`, severity mapping, id prefix).
 *
 * The replay RENDER path reads only `replay.envelope` + `replay.fidelity` (the
 * host builds the shared `SessionReplayResult` from those); the inner
 * `RunPresentation` `result` is a uniform, render-only carrier and is not on the
 * replay render path.
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
export function fitReplayFromSession(stored: StoredSession): ToolSessionReplay<RunPresentation> {
  const decoded = decodeSessionPayload(stored.payload, { tool: 'fit' });

  // Version-aware handling per payload evolution plan.
  // Prefer the version surfaced by the structural decoder (from Phase 0); fall back via the pure helper.
  const version = decoded.payloadVersion ?? extractPayloadVersion(stored.payload) ?? 1;

  if (version > 1) {
    // Future version: warn via diagnostics (observable in --json outcomes) + logger.
    // Still attempt best-effort projection using whatever the structural decoder produced.
    const scope = currentScope();
    scope?.diagnostics?.event(
      'load',
      'warn',
      `fit session payload future version (v=${version}); using projection`,
      { sessionId: stored.id, version },
    );
    // (logger is available via scope or module; diagnostics is the cross-cutting seam)
  }

  const units: UnitResult[] = decoded.checks.map((check) => ({
    slug: check.checkSlug,
    passed: check.passed,
    ...(check.violationCount === undefined ? {} : { violationCount: check.violationCount }),
    durationMs: check.durationMs,
  }));
  const signals = buildReplaySignals({
    stored,
    checks: decoded.checks,
    toolPrefix: 'fit',
    category: 'quality',
  });
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'fit',
    runId: stored.id,
    createdAt: stored.startedAt,
    ...(stored.recipe === undefined ? {} : { recipe: stored.recipe }),
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: decoded.summary,
    },
    units,
    signals,
  };
  return {
    fidelity: 'projection',
    envelope,
    result: { type: 'run-presentation', tool: 'fitness', envelope },
  };
}
