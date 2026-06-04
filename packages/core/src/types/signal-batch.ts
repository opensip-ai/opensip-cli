/**
 * SignalBatch — the unit of cloud signal egress (ADR-0008).
 *
 * Wraps the `Signal[]` a single run produced with the identity the cloud
 * needs to store them (tool, repo, run id, timestamp, counts). This is the
 * wire contract opensip-tools owns; the parent `opensip` repo ingests it.
 * `runId` is the idempotency root — the transport derives a per-chunk
 * `Idempotency-Key` of `${runId}:${ordinal}` (see @opensip-tools/output).
 *
 * `buildSignalBatch` is a pure factory (no IO beyond a truncation log). The
 * findings→Signal mapping that feeds it lives in @opensip-tools/output,
 * because it consumes the `FindingOutput`/`CliOutput` contract types that sit
 * above core in the layer graph.
 */
import { generatePrefixedId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

import type { Signal, SignalSeverity } from './signal.js';

/** Upper bound on signals emitted per batch. The local store keeps everything;
 *  only the cloud emission is bounded, and any drop is logged (no silent caps). */
export const MAX_SIGNALS_PER_BATCH = 5000;

/** Repository identity attached to a batch so stored signals key to a repo+commit. */
export interface RepoIdentity {
  /** Stable repo id when known (e.g. graph's repoId). */
  readonly id?: string;
  /** Origin remote URL, when resolvable. */
  readonly remoteUrl?: string;
  /** HEAD commit sha, when in a git working tree. */
  readonly commit?: string;
}

/** The envelope POSTed to OpenSIP Cloud. `schemaVersion` is the wire-contract version. */
export interface SignalBatch {
  readonly schemaVersion: 1;
  readonly tool: string;
  readonly recipe?: string;
  readonly repo: RepoIdentity;
  readonly runId: string;
  readonly createdAt: string;
  readonly counts: { readonly total: number; readonly bySeverity: Readonly<Record<string, number>> };
  /** Present only when the run exceeded {@link MAX_SIGNALS_PER_BATCH}. */
  readonly truncated?: { readonly dropped: number };
  readonly signals: readonly Signal[];
}

/** Input to {@link buildSignalBatch}. `signals` are already mapped to the wire currency. */
export interface BuildSignalBatchInput {
  readonly tool: string;
  readonly recipe?: string;
  readonly repo: RepoIdentity;
  readonly signals: readonly Signal[];
  /** Override the per-batch cap (tests). Defaults to {@link MAX_SIGNALS_PER_BATCH}. */
  readonly maxSignals?: number;
}

// Highest severity first when we must drop signals to fit the cap.
const SEVERITY_RANK: Record<SignalSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Assemble a {@link SignalBatch}: generate the run id, stamp `createdAt`,
 * compute per-severity counts, and enforce the size cap (keeping the
 * highest-severity signals and logging the dropped count — never a silent cap).
 */
export function buildSignalBatch(input: BuildSignalBatchInput): SignalBatch {
  const max = input.maxSignals ?? MAX_SIGNALS_PER_BATCH;
  let signals = input.signals;
  let truncated: { readonly dropped: number } | undefined;

  if (signals.length > max) {
    const dropped = signals.length - max;
    signals = [...signals]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, max);
    truncated = { dropped };
    logger.warn({ evt: 'cli.signal-sync.truncated', module: 'signal-batch', kept: max, dropped });
  }

  const bySeverity: Record<string, number> = {};
  for (const s of signals) bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;

  return {
    schemaVersion: 1,
    tool: input.tool,
    recipe: input.recipe,
    repo: input.repo,
    runId: generatePrefixedId('run'),
    createdAt: new Date().toISOString(),
    counts: { total: signals.length, bySeverity },
    truncated,
    signals,
  };
}
