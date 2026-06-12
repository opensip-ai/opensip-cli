import { decodeSessionPayload, type DecodedSessionFinding } from '@opensip-cli/session-store';

import type {
  GraphDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

/**
 * Project a stored graph session back into a {@link SignalEnvelope}/{@link GraphDoneResult}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`, here with `requireFilePath`/`requireViolationCount`/
 * `allowMetadata` — graph findings always carry those); this function owns only
 * graph's projection (`tool: 'graph'`, `category: 'architecture'`, signal id
 * prefix, `graph-done` summary).
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
export function graphReplayFromSession(stored: StoredSession): ToolSessionReplay<GraphDoneResult> {
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
  const signals = payload.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      replaySignal(stored, check.checkSlug, finding, checkIndex, findingIndex),
    ),
  );
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'graph',
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
      type: 'graph-done',
      summary: {
        passed: payload.summary.passed,
        failed: payload.summary.failed,
        errors: payload.summary.errors,
        warnings: payload.summary.warnings,
      },
      durationMs: stored.durationMs,
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
  const filePath = finding.filePath ?? '';
  return {
    id: `${stored.id}:graph:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-cli',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'architecture',
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    filePath,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    code: {
      file: filePath,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.column === undefined ? {} : { column: finding.column }),
    },
    metadata: finding.metadata ?? {},
    createdAt: stored.timestamp,
  };
}
