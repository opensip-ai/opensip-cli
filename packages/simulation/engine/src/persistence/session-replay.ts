import { decodeSessionPayload, type DecodedSessionFinding } from '@opensip-tools/session-store';

import type {
  SignalEnvelope,
  SimDoneResult,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/**
 * Project a stored sim session back into a {@link SignalEnvelope}/{@link SimDoneResult}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`); this function owns only sim's projection
 * (`tool: 'sim'`, `category: 'testing'`, signal id prefix, `sim-done` result).
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
export function simReplayFromSession(stored: StoredSession): ToolSessionReplay<SimDoneResult> {
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
    createdAt: stored.timestamp,
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
    result: {
      type: 'sim-done',
      recipeName: stored.recipe ?? 'default',
      cwd: stored.cwd,
      durationMs: stored.durationMs,
      envelope,
    },
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
    provider: 'opensip-tools',
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
    createdAt: stored.timestamp,
  };
}
