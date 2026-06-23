import type { CliDiagnostic } from '../cli-diagnostic.js';
import type { SignalEnvelope } from '../signal-envelope.js';

/**
 * Outcome of `sessions show <ref>` (and the `--show` shorthand on fit/graph/sim)
 * on the non-`--json` path. Unlike a live run, a replay is uniform across tools:
 * it carries the projected {@link SignalEnvelope} (ADR-0011) + display metadata,
 * and `resultToView` renders it through the SAME shared envelope→table view every
 * tool's live results use — so a replayed graph session finally shows a table,
 * and none of them show the live-run "Use --verbose / report" footer (which is
 * guidance for a fresh run, not a replay).
 */
export interface SessionReplayResult {
  type: 'session-replay';
  readonly session: {
    readonly id: string;
    readonly tool: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly recipe?: string;
    readonly score: number;
    readonly passed: boolean;
    readonly durationMs: number;
  };
  /** The projected run envelope — rendered via the shared per-unit table. */
  readonly envelope: SignalEnvelope;
  /** Replay fidelity, e.g. `'projection'` (rebuilt from persisted findings). */
  readonly fidelity: string;
}

export interface HelpResult {
  type: 'help';
}

export interface ErrorResult {
  type: 'error';
  message: string;
  suggestion?: string;
  exitCode: number;
  /** Machine-readable error code (e.g. CLI_DIAGNOSTIC_CODES value). */
  code?: string;
  /** Structured diagnostic substrate when the error is host-classified (ADR-0060). */
  diagnostic?: CliDiagnostic;
}