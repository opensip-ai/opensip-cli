/**
 * Result-shaping builders for {@link SessionResultsReadPort}: pure functions
 * that turn a resolved/replayed session (+ optional baseline) into the MCP
 * reply DTOs. Extracted from the port so the read methods stay focused and
 * within the file-length and cognitive-complexity floors.
 */

import { compareSignalsToBaseline } from './baseline-comparison.js';

import type {
  CompareToBaselineOptions,
  McpBaselineComparisonData,
  McpResultReplay,
  RunSummary,
} from './result-dto.js';
import type { SignalEnvelope, StoredSession } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';
import type { BaselineRepo } from '@opensip-cli/datastore';

/** Build a {@link RunSummary} for a replayed run (summary from the envelope verdict). */
export function runSummaryFromReplay(session: StoredSession, envelope: SignalEnvelope): RunSummary {
  return {
    id: session.id,
    tool: session.tool,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    cwd: session.cwd,
    score: session.score,
    passed: session.passed,
    ...(session.cliVersion === undefined ? {} : { cliVersion: session.cliVersion }),
    ...(session.engineVersion === undefined ? {} : { engineVersion: session.engineVersion }),
    showCommand: `opensip sessions show ${session.id} --json`,
    summary: envelope.verdict.summary,
  };
}

/** Follow-up commands an agent should prefer over re-running the tool. */
export function recommendedNext(session: StoredSession): Record<string, string> {
  const tool = session.tool;
  return {
    showLatestErrorsCommand: `opensip sessions show latest --tool ${tool} --json --filter errors-only`,
    showLatestWarningsCommand: `opensip sessions show latest --tool ${tool} --json --filter warnings-only`,
    showRawEnvelopeCommand: `opensip sessions show ${session.id} --json --raw`,
    rerunCommand: `opensip ${tool}`,
  };
}

/**
 * The `compareToBaseline` reply for a tool with no stored baseline: an
 * `available: false` projection plus a `missing-baseline` degrade and a
 * save-baseline hint.
 */
export function missingBaselineReplay(
  tool: ToolShortId,
  session: StoredSession,
  envelope: SignalEnvelope,
): McpResultReplay<McpBaselineComparisonData> {
  return {
    data: {
      tool,
      baseline: { available: false },
      delta: {
        added: 0,
        resolved: 0,
        unchanged: 0,
        missingFingerprint: envelope.signals.filter((signal) => !signal.fingerprint).length,
      },
      addedFindings: [],
      degraded: [
        {
          code: 'missing-baseline',
          message:
            `No stored baseline exists for ${tool}. Run opensip ${tool} ` +
            '--gate-save to capture one.',
        },
      ],
    },
    session: runSummaryFromReplay(session, envelope),
    recommendedNext: {
      ...recommendedNext(session),
      saveBaselineCommand: `opensip ${tool} --gate-save`,
    },
  };
}

/**
 * The `compareToBaseline` reply for a tool WITH a stored baseline: loads the
 * baseline rows, projects the current replayed signals against them, and shapes
 * the delta. The caller wraps this in one baseline-error try/catch.
 */
export function baselineComparisonReplay(
  repo: BaselineRepo,
  opts: CompareToBaselineOptions,
  session: StoredSession,
  envelope: SignalEnvelope,
): McpResultReplay<McpBaselineComparisonData> {
  const rows = repo.load(opts.tool);
  const capturedAt = repo.capturedAt(opts.tool);
  const identity = repo.loadMeta(opts.tool);
  const projection = compareSignalsToBaseline({
    current: envelope.signals,
    baselineRows: rows,
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    ...(opts.includeResolved === undefined ? {} : { includeResolved: opts.includeResolved }),
  });
  return {
    data: {
      tool: opts.tool,
      baseline: {
        available: true,
        rowCount: rows.length,
        ...(capturedAt === undefined ? {} : { capturedAt: new Date(capturedAt).toISOString() }),
        ...(identity === undefined ? {} : { identity }),
      },
      delta: projection.delta,
      addedFindings: projection.addedFindings,
      ...(projection.resolvedFindings === undefined
        ? {}
        : { resolvedFindings: projection.resolvedFindings }),
      ...(projection.degraded === undefined ? {} : { degraded: projection.degraded }),
    },
    session: runSummaryFromReplay(session, envelope),
    recommendedNext: recommendedNext(session),
  };
}
