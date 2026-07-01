import { yagniFingerprintStrategy } from '../baseline-strategy.js';

import { readYagniSessionPayload } from './session-payload.js';

import type { YagniSessionFinding } from './session-payload.js';
import type {
  RunPresentation,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
  UnitResult,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

/**
 * Project a stored yagni session back into a SignalEnvelope/RunPresentation.
 *
 * Yagni persists the shared `checks[]` payload shape, but its finding metadata is
 * intentionally nested under `metadata.yagni`; replay reads the tool payload
 * directly so that metadata remains intact for agent/session consumers.
 */
export function yagniReplayFromSession(stored: StoredSession): ToolSessionReplay<RunPresentation> {
  const payload = readYagniSessionPayload(stored.payload);
  if (payload === undefined) {
    throw new Error('yagni session has no replay payload');
  }

  const units: UnitResult[] = payload.checks.map((check) => ({
    slug: check.checkSlug,
    passed: check.passed,
    violationCount: check.violationCount,
    durationMs: check.durationMs,
  }));
  const signals = payload.checks.flatMap((check, checkIndex) =>
    check.findings.map((finding, findingIndex) =>
      replaySignal({
        stored,
        source: check.checkSlug,
        finding,
        checkIndex,
        findingIndex,
      }),
    ),
  );
  const { total, passed, failed, errors, warnings } = payload.summary;
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'yagni',
    runId: stored.id,
    createdAt: stored.startedAt,
    ...(stored.recipe === undefined ? {} : { recipe: stored.recipe }),
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: { total, passed, failed, errors, warnings },
    },
    units,
    signals,
    baselineIdentity: {
      fingerprintStrategyId: yagniFingerprintStrategy.id,
      fingerprintStrategyVersion: yagniFingerprintStrategy.version,
    },
  };
  return {
    fidelity: 'projection',
    envelope,
    result: { type: 'run-presentation', tool: 'yagni', envelope },
  };
}

function replaySignal(input: {
  readonly stored: StoredSession;
  readonly source: string;
  readonly finding: YagniSessionFinding;
  readonly checkIndex: number;
  readonly findingIndex: number;
}): Signal {
  const filePath = input.finding.filePath ?? '';
  const metadata = input.finding.metadata ?? {};
  return {
    id: `${input.stored.id}:yagni:${String(input.checkIndex)}:${String(input.findingIndex)}`,
    source: input.source,
    provider: 'yagni',
    severity: input.finding.severity === 'error' ? 'high' : 'medium',
    category: 'quality',
    ruleId: input.finding.ruleId,
    message: input.finding.message,
    filePath,
    ...(input.finding.suggestion === undefined ? {} : { suggestion: input.finding.suggestion }),
    ...(input.finding.line === undefined ? {} : { line: input.finding.line }),
    ...(input.finding.column === undefined ? {} : { column: input.finding.column }),
    ...(input.finding.filePath === undefined
      ? {}
      : {
          code: {
            file: input.finding.filePath,
            ...(input.finding.line === undefined ? {} : { line: input.finding.line }),
            ...(input.finding.column === undefined ? {} : { column: input.finding.column }),
          },
        }),
    metadata,
    createdAt: input.stored.startedAt,
  };
}
