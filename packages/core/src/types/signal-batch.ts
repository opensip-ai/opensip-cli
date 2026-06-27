/**
 * SignalBatch — the unit of cloud signal egress (ADR-0008).
 *
 * Wraps the `Signal[]` a single run produced with the identity the cloud
 * needs to store them (tool, repo, run id, timestamp, counts). This is the
 * wire contract opensip-cli owns; the parent `opensip` repo ingests it.
 * `runId` is the idempotency root — the transport derives a per-chunk
 * `Idempotency-Key` of `${runId}:${ordinal}` (see @opensip-cli/output).
 *
 * `buildSignalBatch` is a pure factory (no IO beyond a truncation log). The
 * run already produces `Signal[]` natively (ADR-0011), so the CLI composition
 * root maps a tool's `SignalEnvelope` to a batch (`deliver-envelope.ts`,
 * @opensip-cli/cli) — no findings→Signal downgrade step exists anymore.
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
  readonly counts: {
    readonly total: number;
    readonly bySeverity: Readonly<Record<string, number>>;
  };
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
  /**
   * Preserve an existing run identity instead of generating a fresh one.
   * The composition root passes the {@link SignalEnvelope}'s `runId` here
   * (ADR-0011) so the cloud-egress idempotency root matches the run the
   * user observed. Omitted → a fresh id is generated.
   */
  readonly runId?: string;
  /** Preserve the envelope's `createdAt` instead of stamping `now`. */
  readonly createdAt?: string;
}

// Highest severity first when we must drop signals to fit the cap.
const SEVERITY_RANK: Record<SignalSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

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
    logger.warn({
      evt: 'cli.signal-sync.truncated',
      module: 'signal-batch',
      kept: max,
      dropped,
    });
  }

  const bySeverity: Record<string, number> = {};
  for (const s of signals) bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;

  return {
    schemaVersion: 1,
    tool: input.tool,
    recipe: input.recipe,
    repo: input.repo,
    runId: input.runId ?? generatePrefixedId('run'),
    createdAt: input.createdAt ?? new Date().toISOString(),
    counts: { total: signals.length, bySeverity },
    truncated,
    signals,
  };
}
