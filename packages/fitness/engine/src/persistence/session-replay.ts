import { decodeSessionPayload, type DecodedSessionFinding } from '@opensip-tools/session-store';

import type {
  FitDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/**
 * Project a stored fit session back into a {@link SignalEnvelope}/{@link FitDoneResult}.
 *
 * The structural decode of the opaque payload is shared across tools
 * (`decodeSessionPayload`); this function owns only fit's projection — the
 * envelope vocabulary (`tool: 'fit'`, recipe label) and the per-finding signal
 * shape (`category: 'quality'`, severity mapping, id prefix).
 *
 * @throws {Error | TypeError} when the stored payload is not the expected shape
 *   (propagated from `decodeSessionPayload`).
 */
export function fitReplayFromSession(
  stored: StoredSession,
): ToolSessionReplay<FitDoneResult> {
  const payload = decodeSessionPayload(stored.payload, { tool: 'fit' });
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
    tool: 'fit',
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
      type: 'fit-done',
      label: stored.recipe ? `recipe ${stored.recipe}` : `session ${stored.id}`,
      cwd: stored.cwd,
      envelope,
      configFound: true,
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
    id: `${stored.id}:fit:${checkIndex}:${findingIndex}`,
    source,
    provider: 'opensip-tools',
    severity: finding.severity === 'error' ? 'high' : 'medium',
    category: 'quality',
    ruleId: finding.ruleId,
    message: finding.message,
    filePath: finding.filePath ?? '',
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.column === undefined ? {} : { column: finding.column }),
    ...(finding.filePath === undefined ? {} : {
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
