/**
 * Architecture-gate primitive — pre/post-fix regression detection.
 *
 * Operations:
 *   - saveBaseline(output, repo)         — persist current SARIF as the baseline
 *   - compareToBaseline(output, repo)    — diff current SARIF against baseline
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
 */

import { createHash } from 'node:crypto';

import { buildSarifLog } from '@opensip-tools/reporting';
import { ConfigurationError, SystemError, logger } from '@opensip-tools/core';

import type { FitBaselineRepo } from './persistence/baseline-repo.js';
import type { CliOutput, SarifResult } from '@opensip-tools/contracts';

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
 * Thrown when the baseline payload exists but isn't a parseable SARIF
 * document. Extends `SystemError` — a corrupted baseline is data
 * integrity, not user-input configuration. The CLI maps it through the
 * standard fatal-runtime path.
 */
export class GateBaselineInvalidError extends SystemError {
  constructor(reason: string) {
    super(
      `Gate baseline is invalid: ${reason}`,
      { code: 'SYSTEM.GATE.BASELINE_CORRUPT' },
    );
    this.name = 'GateBaselineInvalidError';
  }
}

// ---------------------------------------------------------------------------
// saveBaseline
// ---------------------------------------------------------------------------

/**
 * Persist the current run's findings as a baseline SARIF document.
 * Overwrites any existing baseline.
 */
export function saveBaseline(output: CliOutput, repo: FitBaselineRepo): void {
  const sarif = buildSarifLog(output);
  const findingCount = output.checks.reduce((n, c) => n + c.findings.length, 0);
  repo.save(sarif, findingCount);
  logger.info({
    evt: 'cli.gate.save.complete',
    module: 'cli:gate',
    findingCount,
    checkCount: output.checks.length,
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
 * @throws {GateBaselineInvalidError} when the baseline isn't valid SARIF
 */
export function compareToBaseline(
  output: CliOutput,
  repo: FitBaselineRepo,
  identity: ViolationIdentity = DEFAULT_VIOLATION_IDENTITY,
): GateCompareResult {
  const baselineDoc = repo.load();
  if (baselineDoc === null) {
    throw new GateBaselineMissingError();
  }

  const baselineViolations = extractViolationsFromSarif(baselineDoc, identity);
  const currentViolations = extractViolationsFromCliOutput(output, identity);

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
    lines.push(`✗ DEGRADED — ${result.added.length} new violation${result.added.length === 1 ? '' : 's'}`);
  } else if (result.resolved.length > 0) {
    lines.push(`✓ IMPROVED — ${result.resolved.length} violation${result.resolved.length === 1 ? '' : 's'} resolved, none added`);
  } else {
    lines.push(`✓ STABLE — no change`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractViolationsFromCliOutput(output: CliOutput, identity: ViolationIdentity): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const check of output.checks) {
    for (const f of check.findings) {
      const filePath = f.filePath ?? '';
      violations.push({
        hash: identity({ filePath, ruleId: f.ruleId, message: f.message }),
        ruleId: f.ruleId,
        message: f.message,
        filePath,
        line: f.line,
        severity: f.severity,
      });
    }
  }
  return violations;
}

interface SarifRun {
  tool?: { driver?: { name?: string } };
  results?: readonly SarifResult[];
}

interface SarifDoc {
  version?: string;
  runs?: readonly SarifRun[];
}

/**
 * Convert a parsed SARIF document into the gate's internal `GateViolation`
 * shape.
 *
 * @throws {GateBaselineInvalidError} When `doc` is not an object or its
 *   `runs` property is missing or not an array — the SARIF document is
 *   structurally invalid for our gate consumer.
 */
function extractViolationsFromSarif(
  doc: unknown,
  identity: ViolationIdentity,
): GateViolation[] {
  if (typeof doc !== 'object' || doc === null) {
    throw new GateBaselineInvalidError('top-level value is not an object');
  }
  const sarif = doc as SarifDoc;
  if (sarif.runs === undefined || !Array.isArray(sarif.runs)) {
    throw new GateBaselineInvalidError('missing or non-array `runs`');
  }

  const runs: readonly SarifRun[] = sarif.runs;
  const violations: GateViolation[] = [];
  for (const run of runs) {
    const results: readonly SarifResult[] | undefined = run.results;
    if (results === undefined) continue;
    for (const result of results) {
      const ruleId = result.ruleId ?? '';
      const message = result.message?.text ?? '';
      const loc = result.locations?.[0]?.physicalLocation;
      const filePath = loc?.artifactLocation?.uri ?? '';
      const line = loc?.region?.startLine;
      const severity = result.level === 'error' ? 'error' : 'warning';
      violations.push({
        hash: identity({ filePath, ruleId, message }),
        ruleId,
        message,
        filePath,
        line,
        severity,
      });
    }
  }
  return violations;
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
