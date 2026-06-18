import { decodeSessionPayload, type DecodedSessionFinding } from '@opensip-cli/session-store';

import type {
  RunPresentation,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

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
  const signals = payload.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      replaySignal(stored, check.checkSlug, finding, checkIndex, findingIndex),
    ),
  );
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

function replaySignal(
  stored: StoredSession,
  source: string,
  finding: DecodedSessionFinding,
  checkIndex: number,
  findingIndex: number,
): Signal {
  return {
    id: `${stored.id}:sim:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-cli',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'testing',
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    filePath: finding.filePath ?? '',
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    ...(finding.filePath === undefined
      ? {}
      : {
          code: {
            file: finding.filePath,
            ...(finding.line === undefined ? {} : { line: finding.line }),
            ...(finding.column === undefined ? {} : { column: finding.column }),
          },
        }),
    metadata: {},
    createdAt: stored.startedAt,
  };
}
