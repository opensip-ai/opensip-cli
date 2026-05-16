/**
 * Architecture-gate primitive — pre/post-fix regression detection for graph.
 *
 * Mirrors the shape of `packages/fitness/engine/src/gate.ts`. The graph
 * baseline is a SARIF document derived from the same `CliOutput` shape the
 * fitness gate uses, so the gate-compare diff logic is a direct port.
 *
 * The `--gate-save` and `--gate-compare` flag wiring lives on the Tool's
 * Commander handler in `tool.ts`. Errors thrown here surface as
 * GraphBaselineMissingError / GraphBaselineInvalidError; the handler
 * translates them into stderr messages + exit codes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CliOutput } from '@opensip-tools/contracts';

// Minimal SARIF builder inlined here per spec §7.3 (Option B for v0.1) —
// the fitness package's buildSarifLog has the same shape but the graph
// tool is intentionally not importing fitness. Promotion to a shared
// `@opensip-tools/sarif` package is the follow-up after both Tools'
// usage patterns stabilize.

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: readonly {
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }[];
}

interface SarifRun {
  tool?: { driver?: { name?: string; version?: string; rules?: readonly { id: string }[] } };
  results?: readonly SarifResult[];
}

interface SarifDoc {
  version?: string;
  $schema?: string;
  runs?: readonly SarifRun[];
}

const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';

/** Default location for the graph gate baseline. */
export const DEFAULT_GRAPH_BASELINE_PATH = 'opensip-tools/.runtime/graph-baseline.sarif';

interface GateViolation {
  readonly hash: string;
  readonly ruleId: string;
  readonly message: string;
  readonly filePath: string;
  readonly line?: number;
  readonly severity: 'error' | 'warning';
}

export interface GraphGateCompareResult {
  readonly baselinePath: string;
  readonly added: readonly GateViolation[];
  readonly resolved: readonly GateViolation[];
  readonly unchanged: readonly GateViolation[];
  readonly degraded: boolean;
}

export class GraphBaselineMissingError extends Error {
  readonly baselinePath: string;
  constructor(baselinePath: string) {
    super(
      `Graph baseline not found at ${baselinePath}. ` +
        `Run \`opensip-tools graph --gate-save\` first to create one, ` +
        `or pass --baseline <path> if it lives elsewhere.`,
    );
    this.name = 'GraphBaselineMissingError';
    this.baselinePath = baselinePath;
  }
}

export class GraphBaselineInvalidError extends Error {
  readonly baselinePath: string;
  constructor(baselinePath: string, reason: string) {
    super(`Graph baseline at ${baselinePath} is invalid: ${reason}`);
    this.name = 'GraphBaselineInvalidError';
    this.baselinePath = baselinePath;
  }
}

/** Persist the current run's findings as a SARIF baseline. */
export function saveBaseline(output: CliOutput, baselinePath: string): void {
  const sarif = buildGraphSarifLog(output);
  const dir = dirname(baselinePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(sarif, null, 2), 'utf8');
}

/** Compare the current run's findings against a saved baseline. */
export function compareToBaseline(output: CliOutput, baselinePath: string): GraphGateCompareResult {
  if (!existsSync(baselinePath)) {
    throw new GraphBaselineMissingError(baselinePath);
  }

  const baselineRaw = readFileSync(baselinePath, 'utf8');
  let baselineDoc: unknown;
  try {
    baselineDoc = JSON.parse(baselineRaw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GraphBaselineInvalidError(baselinePath, `not valid JSON (${reason})`);
  }

  const baselineViolations = extractViolationsFromSarif(baselineDoc, baselinePath);
  const currentViolations = extractViolationsFromCliOutput(output);

  const baselineByHash = new Map(baselineViolations.map((v) => [v.hash, v]));
  const currentByHash = new Map(currentViolations.map((v) => [v.hash, v]));

  const added: GateViolation[] = [];
  const unchanged: GateViolation[] = [];
  for (const [hash, v] of currentByHash) {
    if (baselineByHash.has(hash)) unchanged.push(v);
    else added.push(v);
  }

  const resolved: GateViolation[] = [];
  for (const [hash, v] of baselineByHash) {
    if (!currentByHash.has(hash)) resolved.push(v);
  }

  return {
    baselinePath,
    added,
    resolved,
    unchanged,
    degraded: added.length > 0,
  };
}

/** Pretty-print the gate compare result for stdout. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-section diff renderer: added/resolved/unchanged sections each shape output; flatter form would scatter formatting
export function renderGateCompareOutput(result: GraphGateCompareResult): string {
  const lines: string[] = ['opensip-tools graph gate compare', ''];

  if (result.added.length > 0) {
    lines.push(`Added (${result.added.length}):`);
    for (const v of sortViolations(result.added)) {
      lines.push(`  x ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
      if (v.message && v.message !== v.ruleId) {
        lines.push(`      ${truncate(v.message, 120)}`);
      }
    }
    lines.push('');
  }

  if (result.resolved.length > 0) {
    lines.push(`Resolved (${result.resolved.length}):`);
    for (const v of sortViolations(result.resolved)) {
      lines.push(`  - ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
    }
    lines.push('');
  }

  if (result.unchanged.length > 0) {
    lines.push(`Unchanged (${result.unchanged.length}):`);
    const sample = sortViolations(result.unchanged).slice(0, 5);
    for (const v of sample) {
      lines.push(`  . ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
    }
    if (result.unchanged.length > sample.length) {
      lines.push(`  . ... and ${result.unchanged.length - sample.length} more`);
    }
    lines.push('');
  }

  if (result.degraded) {
    lines.push(`DEGRADED — ${result.added.length} new violation${result.added.length === 1 ? '' : 's'}`);
  } else if (result.resolved.length > 0) {
    lines.push(`IMPROVED — ${result.resolved.length} violation${result.resolved.length === 1 ? '' : 's'} resolved, none added`);
  } else {
    lines.push('STABLE — no change');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal: SARIF builder + extractors
// ---------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/cognitive-complexity -- SARIF builder: assembles rules + results per check; flatter shape would scatter the per-check loop
function buildGraphSarifLog(output: CliOutput): SarifDoc {
  const runs: SarifRun[] = [];
  for (const ch of output.checks) {
    if (ch.findings.length === 0) continue;
    const ruleIds = new Set<string>();
    const results: SarifResult[] = [];
    for (const f of ch.findings) {
      ruleIds.add(f.ruleId);
      const result: SarifResult = {
        ruleId: f.ruleId,
        message: { text: f.message },
        level: f.severity === 'error' ? 'error' : 'warning',
      };
      if (f.filePath) {
        const region: { startLine?: number } = {};
        if (f.line != null && f.line > 0) region.startLine = f.line;
        result.locations = [
          {
            physicalLocation: {
              artifactLocation: { uri: f.filePath },
              ...(region.startLine == null ? {} : { region }),
            },
          },
        ];
      }
      results.push(result);
    }
    runs.push({
      tool: {
        driver: {
          name: ch.checkSlug,
          version: '1.0.0',
          rules: [...ruleIds].map((id) => ({ id })),
        },
      },
      results,
    });
  }
  return { version: '2.1.0', $schema: SARIF_SCHEMA, runs };
}

function hashViolation(filePath: string, ruleId: string, message: string): string {
  return createHash('sha256').update(`${filePath}\n${ruleId}\n${message}`).digest('hex');
}

function extractViolationsFromCliOutput(output: CliOutput): GateViolation[] {
  const out: GateViolation[] = [];
  for (const ch of output.checks) {
    for (const f of ch.findings) {
      const filePath = f.filePath ?? '';
      out.push({
        hash: hashViolation(filePath, f.ruleId, f.message),
        ruleId: f.ruleId,
        message: f.message,
        filePath,
        ...(f.line == null ? {} : { line: f.line }),
        severity: f.severity,
      });
    }
  }
  return out;
}

function extractViolationsFromSarif(doc: unknown, baselinePath: string): GateViolation[] {
  if (typeof doc !== 'object' || doc === null) {
    throw new GraphBaselineInvalidError(baselinePath, 'top-level value is not an object');
  }
  const sarif = doc as SarifDoc;
  if (sarif.runs === undefined || !Array.isArray(sarif.runs)) {
    throw new GraphBaselineInvalidError(baselinePath, 'missing or non-array `runs`');
  }
  const runs: readonly SarifRun[] = sarif.runs;
  const out: GateViolation[] = [];
  for (const run of runs) {
    const results: readonly SarifResult[] | undefined = run.results;
    if (results === undefined) continue;
    for (const result of results) {
      const ruleId = result.ruleId ?? '';
      const message = result.message?.text ?? '';
      const loc = result.locations?.[0]?.physicalLocation;
      const filePath = loc?.artifactLocation?.uri ?? '';
      const line = loc?.region?.startLine;
      const severity: 'error' | 'warning' = result.level === 'error' ? 'error' : 'warning';
      out.push({
        hash: hashViolation(filePath, ruleId, message),
        ruleId,
        message,
        filePath,
        ...(line == null ? {} : { line }),
        severity,
      });
    }
  }
  return out;
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
