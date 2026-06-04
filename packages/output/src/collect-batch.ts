/**
 * collectSignalBatch — map a run's `CliOutput` into a `SignalBatch` for cloud
 * egress (ADR-0008).
 *
 * Lives here rather than in core because it consumes the `CliOutput` /
 * `FindingOutput` contract types, which sit above core in the layer graph.
 * Pure: repo identity is resolved by the caller (the CLI composition root)
 * and passed in, so this stays free of git/process IO.
 */
import { buildSignalBatch, createSignal } from '@opensip-tools/core';

import type { CliOutput, FindingOutput } from '@opensip-tools/contracts';
import type { SignalBatch, RepoIdentity, Signal, SignalSeverity } from '@opensip-tools/core';

// A fitness/graph finding is error|warning; signals carry the richer OpenSIP
// severity scale. Map to the nearest rung (the platform can refine later).
const SEVERITY_MAP: Record<FindingOutput['severity'], SignalSeverity> = {
  error: 'high',
  warning: 'medium',
};

/** Input to {@link collectSignalBatch}. `repo` is resolved by the caller. */
export interface CollectSignalBatchInput {
  readonly tool: string;
  readonly recipe?: string;
  readonly repo: RepoIdentity;
  readonly output: CliOutput;
  /** Override the per-batch cap (tests). */
  readonly maxSignals?: number;
}

/**
 * Flatten every check's findings into `Signal`s and assemble the batch. The
 * check slug becomes the signal `source`; severity is mapped to the OpenSIP
 * scale. Envelope assembly (run id, counts, cap) is delegated to
 * {@link buildSignalBatch}.
 */
export function collectSignalBatch(input: CollectSignalBatchInput): SignalBatch {
  const signals: Signal[] = [];
  for (const check of input.output.checks) {
    for (const f of check.findings) {
      signals.push(
        createSignal({
          source: check.checkSlug,
          severity: SEVERITY_MAP[f.severity],
          ruleId: f.ruleId,
          message: f.message,
          suggestion: f.suggestion,
          code: { file: f.filePath, line: f.line, column: f.column },
          metadata: f.metadata,
        }),
      );
    }
  }

  return buildSignalBatch({
    tool: input.tool,
    recipe: input.recipe ?? input.output.recipe,
    repo: input.repo,
    signals,
    maxSignals: input.maxSignals,
  });
}
