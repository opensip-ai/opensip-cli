/**
 * Architecture-gate primitive — pre/post-fix regression detection.
 *
 * Operations:
 *   - saveBaseline(envelope, repo)       — persist the run's signal envelope as the baseline
 *   - compareToBaseline(envelope, repo)  — diff the current envelope against the baseline
 *   - renderGateCompareOutput(result)    — pretty-print the diff for stdout
 *
 * Wired into the `fit` command via `--gate-save` and `--gate-compare` flags
 * (see commands/fit.ts and index.ts).
 *
 * v2: the baseline lives in SQLite via `FitBaselineRepo`. v1's
 * `--baseline <path>` flag is removed — there is now exactly one
 * baseline per project, stored at `<project>/opensip-tools/.runtime/datastore.sqlite`.
 * Diffs match by (filePath, ruleId, message) — line numbers are
 * intentionally NOT in the matching key so unrelated line shifts
 * don't register as added/resolved violations.
 *
 * ADR-0011 Phase 6: the baseline stores the run's {@link SignalEnvelope}
 * (signals) directly — NOT a SARIF document — mirroring graph's signal-keyed
 * baseline. This removes fitness's `@opensip-tools/output` production
 * dependency (the root owns all SARIF egress). `fit-baseline-export` reads the
 * stored envelope back and writes SARIF to disk via the root `cli.writeSarif`
 * seam, so the on-disk CI artifact stays a SARIF document. The datastore is a
 * rebuildable local cache (ADR-0006); no migration of pre-existing rows.
 */

import { createHash } from 'node:crypto';

import { ConfigurationError, SystemError, isErrorSignal, logger } from '@opensip-tools/core';

import type { FitBaselineRepo } from './persistence/baseline-repo.js';
import type { SignalEnvelope } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single violation as it appears in the gate diff. */
interface GateViolation {
  /** sha256(filePath + '\n' + ruleId + '\n' + message) — opaque identity */
  readonly hash: string;
  readonly ruleId: string;
  readonly message: string;
  readonly filePath: string;
  /** Line number — informational only, NOT used in identity */
  readonly line?: number;
  readonly severity: 'error' | 'warning';
}

/** Result of comparing current state to a saved baseline. */
export interface GateCompareResult {
  /** Violations present now but not in baseline. */
  readonly added: readonly GateViolation[];
  /** Violations present in baseline but not now. */
  readonly resolved: readonly GateViolation[];
  /** Violations present in both. */
  readonly unchanged: readonly GateViolation[];
  /** True iff `added` is non-empty — the gate decision. */
  readonly degraded: boolean;
}

/**
 * Strategy describing how a single violation is hashed into a stable
 * identity for diffing. The default identity uses
 * `(filePath, ruleId, message)`, which preserves the line-shift
 * tolerance documented at the top of this file. A test (or downstream
 * consumer) may pass a different strategy — e.g. `(filePath, ruleId)`
 * to ignore message edits, or `(ruleId)` to count "any new violation
 * of this rule" as a regression. Output of the strategy is opaque; the
 * caller never inspects it.
 */
export type ViolationIdentity = (input: {
  readonly filePath: string;
  readonly ruleId: string;
  readonly message: string;
}) => string;

/** Default identity: sha256 over (filePath, ruleId, message). */
export const DEFAULT_VIOLATION_IDENTITY: ViolationIdentity = ({ filePath, ruleId, message }) =>
  createHash('sha256').update(`${filePath}\n${ruleId}\n${message}`).digest('hex');

/**
 * Thrown when --gate-compare is invoked but the baseline doesn't exist.
 *
 * Extends `ConfigurationError` so the CLI's top-level `handleParseError`
 * maps it to `EXIT_CODES.CONFIGURATION_ERROR` automatically — no
 * per-command try/catch needed in `tool.ts`.
 */
export class GateBaselineMissingError extends ConfigurationError {
  constructor() {
    super(
      'Gate baseline not found in the project SQLite store. ' +
        'Run `opensip-tools fit --gate-save` first to create one.',
      { code: 'CONFIGURATION.GATE.BASELINE_MISSING' },
    );
    this.name = 'GateBaselineMissingError';
  }
}

/**
 * Thrown when the baseline payload exists but isn't a parseable
 * `SignalEnvelope`. Extends `SystemError` — a corrupted baseline is data
 * integrity, not user-input configuration. The CLI maps it through the
 * standard fatal-runtime path.
 */
export class GateBaselineInvalidError extends SystemError {
  constructor(reason: string) {
    super(`Gate baseline is invalid: ${reason}`, { code: 'SYSTEM.GATE.BASELINE_CORRUPT' });
    this.name = 'GateBaselineInvalidError';
  }
}

// ---------------------------------------------------------------------------
// saveBaseline
// ---------------------------------------------------------------------------

/**
 * Persist the current run's {@link SignalEnvelope} as the gate baseline.
 * Overwrites any existing baseline. The signals ARE the baseline (no SARIF
 * detour); `fit-baseline-export` converts the stored envelope to a SARIF file
 * via the root `cli.writeSarif` seam when CI needs the on-disk artifact.
 */
export function saveBaseline(envelope: SignalEnvelope, repo: FitBaselineRepo): void {
  const findingCount = envelope.signals.length;
  repo.save(envelope, findingCount);
  logger.info({
    evt: 'cli.gate.save.complete',
    module: 'cli:gate',
    findingCount,
    checkCount: envelope.units.length,
  });
}

// ---------------------------------------------------------------------------
// compareToBaseline
// ---------------------------------------------------------------------------

/**
 * Compare current findings against a saved baseline. Returns a structured
 * diff of added / resolved / unchanged violations.
 *
 * @param identity - Optional violation-identity strategy. Defaults to
 *   `(filePath, ruleId, message)` — the historical semantics. Pass a
 *   custom strategy to coarsen or refine the diffing behavior without
 *   forking compareToBaseline.
 *
 * @throws {GateBaselineMissingError} when the baseline doesn't exist
 * @throws {GateBaselineInvalidError} when the stored baseline isn't a
 *   parseable signal envelope
 */
export function compareToBaseline(
  envelope: SignalEnvelope,
  repo: FitBaselineRepo,
  identity: ViolationIdentity = DEFAULT_VIOLATION_IDENTITY,
): GateCompareResult {
  const baselineDoc = repo.load();
  if (baselineDoc === null) {
    throw new GateBaselineMissingError();
  }

  const baselineViolations = extractViolationsFromStoredBaseline(baselineDoc, identity);
  const currentViolations = extractViolationsFromEnvelope(envelope, identity);

  const baselineByHash = new Map(baselineViolations.map((v) => [v.hash, v]));
  const currentByHash = new Map(currentViolations.map((v) => [v.hash, v]));

  const added: GateViolation[] = [];
  const unchanged: GateViolation[] = [];
  for (const [hash, v] of currentByHash) {
    if (baselineByHash.has(hash)) {
      unchanged.push(v);
    } else {
      added.push(v);
    }
  }

  const resolved: GateViolation[] = [];
  for (const [hash, v] of baselineByHash) {
    if (!currentByHash.has(hash)) {
      resolved.push(v);
    }
  }

  const result: GateCompareResult = {
    added,
    resolved,
    unchanged,
    degraded: added.length > 0,
  };

  logger.info({
    evt: 'cli.gate.compare.complete',
    module: 'cli:gate',
    addedCount: added.length,
    resolvedCount: resolved.length,
    unchangedCount: unchanged.length,
    degraded: result.degraded,
  });

  return result;
}

// ---------------------------------------------------------------------------
// renderGateCompareOutput
// ---------------------------------------------------------------------------

/**
 * Pretty-print a gate compare result for stdout. Caller sets the exit code.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-section diff renderer: added/removed/changed sections each shape output; flatter form would scatter formatting
export function renderGateCompareOutput(result: GateCompareResult): string {
  const lines: string[] = ['opensip-tools gate compare', ''];

  if (result.added.length > 0) {
    lines.push(`Added (${result.added.length}):`);
    for (const v of sortViolations(result.added)) {
      lines.push(`  ✗ ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
      if (v.message && v.message !== v.ruleId) {
        lines.push(`      ${truncate(v.message, 120)}`);
      }
    }
    lines.push('');
  }

  if (result.resolved.length > 0) {
    lines.push(`Resolved (${result.resolved.length}):`);
    for (const v of sortViolations(result.resolved)) {
      lines.push(`  ✓ ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
    }
    lines.push('');
  }

  if (result.unchanged.length > 0) {
    lines.push(`Unchanged (${result.unchanged.length}):`);
    // Truncate unchanged list — usually long and not actionable.
    const sample = sortViolations(result.unchanged).slice(0, 5);
    for (const v of sample) {
      lines.push(`  · ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
    }
    if (result.unchanged.length > sample.length) {
      lines.push(`  · ... and ${result.unchanged.length - sample.length} more`);
    }
    lines.push('');
  }

  if (result.degraded) {
    lines.push(
      `✗ DEGRADED — ${result.added.length} new violation${result.added.length === 1 ? '' : 's'}`,
    );
  } else if (result.resolved.length > 0) {
    lines.push(
      `✓ IMPROVED — ${result.resolved.length} violation${result.resolved.length === 1 ? '' : 's'} resolved, none added`,
    );
  } else {
    lines.push(`✓ STABLE — no change`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The gate's 2-level severity for a signal (`critical|high → error`). */
function signalGateSeverity(signal: Signal): 'error' | 'warning' {
  return isErrorSignal(signal) ? 'error' : 'warning';
}

/**
 * Extract the gate's `GateViolation[]` from the run's {@link SignalEnvelope}.
 * Iterates the flat `signals` list; the diff identity is UNCHANGED —
 * `(filePath, ruleId, message)` — so existing baselines keep matching across
 * the CliOutput→envelope migration. `ruleId` is `signal.ruleId` (the check
 * slug, the same value the old `FindingOutput.ruleId` carried).
 */
function extractViolationsFromEnvelope(
  envelope: SignalEnvelope,
  identity: ViolationIdentity,
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const signal of envelope.signals) {
    const filePath = signal.filePath;
    violations.push({
      hash: identity({ filePath, ruleId: signal.ruleId, message: signal.message }),
      ruleId: signal.ruleId,
      message: signal.message,
      filePath,
      line: signal.line,
      severity: signalGateSeverity(signal),
    });
  }
  return violations;
}

/** The structural subset of a stored baseline this gate reads back: its signals. */
interface StoredBaselineEnvelope {
  signals?: readonly Signal[];
}

/**
 * Extract the gate's `GateViolation[]` from a stored baseline — the
 * {@link SignalEnvelope} that `saveBaseline` persisted. Reads the same flat
 * `signals` list `extractViolationsFromEnvelope` uses on the current run, so
 * baseline and current are diffed on identical `(filePath, ruleId, message)`
 * identity.
 *
 * @throws {GateBaselineInvalidError} When `doc` is not an object or its
 *   `signals` property is missing or not an array — the stored baseline is
 *   structurally invalid for our gate consumer.
 */
function extractViolationsFromStoredBaseline(
  doc: unknown,
  identity: ViolationIdentity,
): GateViolation[] {
  if (typeof doc !== 'object' || doc === null) {
    throw new GateBaselineInvalidError('top-level value is not an object');
  }
  const baseline = doc as StoredBaselineEnvelope;
  if (baseline.signals === undefined || !Array.isArray(baseline.signals)) {
    throw new GateBaselineInvalidError('missing or non-array `signals`');
  }
  return extractViolationsFromEnvelope(
    { signals: baseline.signals } as unknown as SignalEnvelope,
    identity,
  );
}

function formatLocation(v: GateViolation): string {
  if (!v.filePath) return '(no location)';
  return v.line == null ? v.filePath : `${v.filePath}:${v.line}`;
}

function sortViolations(vs: readonly GateViolation[]): GateViolation[] {
  return [...vs].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
