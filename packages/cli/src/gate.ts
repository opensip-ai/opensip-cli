/**
 * Architecture-gate primitive — pre/post-fix regression detection.
 *
 * Operations:
 *   - saveBaseline(output, path)         — persist current SARIF as the baseline
 *   - compareToBaseline(output, path)    — diff current SARIF against baseline
 *   - renderGateCompareOutput(result)    — pretty-print the diff for stdout
 *
 * Wired into the `fit` command via `--gate-save` and `--gate-compare` flags
 * (see commands/fit.ts and index.ts).
 *
 * The baseline is opensip-tools' own SARIF document (built via buildSarifLog),
 * persisted as a file. Diffs match by (filePath, ruleId, message) — line
 * numbers are intentionally NOT in the matching key so unrelated line shifts
 * don't register as added/resolved violations.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger } from '@opensip-tools/core';

import { buildSarifLog } from './sarif.js';
import type { CliOutput } from '@opensip-tools/cli-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single violation as it appears in the gate diff. */
export interface GateViolation {
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
  readonly baselinePath: string;
  /** Violations present now but not in baseline. */
  readonly added: ReadonlyArray<GateViolation>;
  /** Violations present in baseline but not now. */
  readonly resolved: ReadonlyArray<GateViolation>;
  /** Violations present in both. */
  readonly unchanged: ReadonlyArray<GateViolation>;
  /** True iff `added` is non-empty — the gate decision. */
  readonly degraded: boolean;
}

/** Thrown when --gate-compare is invoked but the baseline file doesn't exist. */
export class GateBaselineMissingError extends Error {
  readonly baselinePath: string;
  constructor(baselinePath: string) {
    super(
      `Gate baseline not found at ${baselinePath}. ` +
        `Run \`opensip-tools fit --gate-save\` first to create one, ` +
        `or pass --baseline <path> if it lives elsewhere.`,
    );
    this.name = 'GateBaselineMissingError';
    this.baselinePath = baselinePath;
  }
}

/** Thrown when the baseline file exists but isn't a parseable SARIF document. */
export class GateBaselineInvalidError extends Error {
  readonly baselinePath: string;
  constructor(baselinePath: string, reason: string) {
    super(`Gate baseline at ${baselinePath} is invalid: ${reason}`);
    this.name = 'GateBaselineInvalidError';
    this.baselinePath = baselinePath;
  }
}

// ---------------------------------------------------------------------------
// Default baseline path
// ---------------------------------------------------------------------------

/** Default location for the baseline file when --baseline is not specified. */
export const DEFAULT_BASELINE_PATH = '.opensip-tools/baseline.sarif';

// ---------------------------------------------------------------------------
// saveBaseline
// ---------------------------------------------------------------------------

/**
 * Persist the current run's findings as a baseline SARIF document.
 * Creates parent directories as needed. Overwrites any existing baseline.
 */
export function saveBaseline(output: CliOutput, baselinePath: string): void {
  const sarif = buildSarifLog(output);
  const dir = dirname(baselinePath);
  // mkdirSync with recursive: true is idempotent — no need to check existsSync first.
  mkdirSync(dir, { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(sarif, null, 2), 'utf-8');

  const findingCount = output.checks.reduce((n, c) => n + c.findings.length, 0);
  logger.info({
    evt: 'cli.gate.save.complete',
    module: 'cli:gate',
    baselinePath,
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
 * @throws {GateBaselineMissingError} when the baseline file doesn't exist
 * @throws {GateBaselineInvalidError} when the baseline isn't valid SARIF
 */
export function compareToBaseline(output: CliOutput, baselinePath: string): GateCompareResult {
  if (!existsSync(baselinePath)) {
    throw new GateBaselineMissingError(baselinePath);
  }

  const baselineRaw = readFileSync(baselinePath, 'utf-8');
  let baselineDoc: unknown;
  try {
    baselineDoc = JSON.parse(baselineRaw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GateBaselineInvalidError(baselinePath, `not valid JSON (${reason})`);
  }

  const baselineViolations = extractViolationsFromSarif(baselineDoc, baselinePath);
  const currentViolations = extractViolationsFromCliOutput(output);

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
    baselinePath,
    added,
    resolved,
    unchanged,
    degraded: added.length > 0,
  };

  logger.info({
    evt: 'cli.gate.compare.complete',
    module: 'cli:gate',
    baselinePath,
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
export function renderGateCompareOutput(result: GateCompareResult): string {
  const lines: string[] = [];
  lines.push('opensip-tools gate compare');
  lines.push('');

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

function hashViolation(filePath: string, ruleId: string, message: string): string {
  return createHash('sha256').update(`${filePath}\n${ruleId}\n${message}`).digest('hex');
}

function extractViolationsFromCliOutput(output: CliOutput): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const check of output.checks) {
    for (const f of check.findings) {
      const filePath = f.filePath ?? '';
      violations.push({
        hash: hashViolation(filePath, f.ruleId, f.message),
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

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: ReadonlyArray<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
}

interface SarifRun {
  tool?: { driver?: { name?: string } };
  results?: ReadonlyArray<SarifResult>;
}

interface SarifDoc {
  version?: string;
  runs?: ReadonlyArray<SarifRun>;
}

function extractViolationsFromSarif(doc: unknown, baselinePath: string): GateViolation[] {
  if (typeof doc !== 'object' || doc === null) {
    throw new GateBaselineInvalidError(baselinePath, 'top-level value is not an object');
  }
  const sarif = doc as SarifDoc;
  if (!Array.isArray(sarif.runs)) {
    throw new GateBaselineInvalidError(baselinePath, 'missing or non-array `runs`');
  }

  const violations: GateViolation[] = [];
  for (const run of sarif.runs) {
    if (!Array.isArray(run.results)) continue;
    for (const result of run.results) {
      const ruleId = result.ruleId ?? '';
      const message = result.message?.text ?? '';
      const loc = result.locations?.[0]?.physicalLocation;
      const filePath = loc?.artifactLocation?.uri ?? '';
      const line = loc?.region?.startLine;
      const severity = result.level === 'error' ? 'error' : 'warning';
      violations.push({
        hash: hashViolation(filePath, ruleId, message),
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
  return v.line != null ? `${v.filePath}:${v.line}` : v.filePath;
}

function sortViolations(vs: ReadonlyArray<GateViolation>): GateViolation[] {
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
