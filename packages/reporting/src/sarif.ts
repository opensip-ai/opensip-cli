import { generatePrefixedId } from '@opensip-tools/core';

import { postChunked } from './http-egress.js';

import type { SarifResult, SarifLocation } from './sarif-types.js';
import type { CliOutput } from '@opensip-tools/contracts';

const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';
const MAX_FINDINGS_PER_CHUNK = 500;

/** Result of a cloud report upload */
export interface ReportResult {
  readonly url: string;
  readonly findingCount: number;
  readonly runCount: number;
  readonly success: boolean;
  readonly error?: string;
  readonly chunksTotal?: number;
  readonly chunksSucceeded?: number;
}

interface SarifRun {
  tool: { driver: { name: string; version: string; rules: { id: string }[] } };
  results: SarifResult[];
}

/**
 * Fluent builder for a single SARIF result. Replaces the inline
 * Record-shaped construction in `buildSarifRuns`; keeps the producer
 * type-aligned with the consumer (fitness `gate.ts
 * extractViolationsFromSarif`) by routing every result through the
 * shared `SarifResult` interface.
 */
class SarifResultBuilder {
  private readonly result: SarifResult;

  constructor(ruleId: string, message: string) {
    this.result = {
      ruleId,
      message: { text: message },
    };
  }

  withSeverity(severity: 'error' | 'warning'): this {
    this.result.level = severity === 'error' ? 'error' : 'warning';
    return this;
  }

  /**
   * Attach a physical location (file + optional region). SARIF
   * `startLine`/`startColumn` are 1-based per spec § 3.30.6; values of
   * 0 are invalid, and fitness signals without a line often carry
   * `line=0` as a sentinel — those are skipped rather than emitted as
   * invalid SARIF.
   */
  withLocation(filePath: string, line?: number, column?: number): this {
    if (!filePath) return this;
    const region: { startLine?: number; startColumn?: number } = {};
    if (line != null && line > 0) region.startLine = line;
    if (column != null && column > 0) region.startColumn = column;
    const location: SarifLocation = {
      physicalLocation: {
        artifactLocation: { uri: filePath },
        ...(Object.keys(region).length > 0 ? { region } : {}),
      },
    };
    this.result.locations = [location];
    return this;
  }

  /**
   * Append a remediation hint to the result message. SARIF's `fixes`
   * array requires `artifactChanges` (spec §3.55) — a structured
   * replacement region. Fitness only has prose advice, so emitting it
   * as a `fix` produces schema-invalid SARIF (GitHub Code Scanning
   * rejects the upload). Surfacing the suggestion in `message.text`
   * keeps it visible in the alert UI without lying about its shape.
   */
  withSuggestion(suggestion: string): this {
    if (!suggestion) return this;
    const existing = this.result.message?.text ?? '';
    this.result.message = {
      text: existing ? `${existing}\n\nSuggestion: ${suggestion}` : `Suggestion: ${suggestion}`,
    };
    return this;
  }

  build(): SarifResult {
    return this.result;
  }
}

/**
 * Tool driver name in the emitted SARIF. Matches the CodeQL Action
 * `category` set in the CI workflow (`opensip-tools-fit`); both must
 * agree so Code Scanning groups our findings under a single tool.
 */
const TOOL_DRIVER_NAME = 'opensip-tools-fit';
const TOOL_DRIVER_VERSION = '2.0.0';

/**
 * Build a SARIF 2.1.0 log from CLI output.
 *
 * SARIF models one `run` as one analysis tool's output. Fitness is the
 * tool; each check is a *rule* within fitness — not a separate tool.
 * The emitted log therefore contains a single run with all findings
 * aggregated and every check exposed as an entry in
 * `tool.driver.rules`.
 *
 * The previous one-run-per-check shape hit the GitHub Code Scanning
 * REST limit ("No more than 25 items are allowed; N were supplied")
 * the moment fitness ran more than 25 checks with findings.
 */
export function buildSarifLog(output: CliOutput): Record<string, unknown> {
  return wrapSarifLog(buildSarifRuns(output));
}

function buildSarifRuns(output: CliOutput): SarifRun[] {
  const ruleIds = new Set<string>();
  const results: SarifResult[] = [];

  for (const ch of output.checks) {
    if (ch.findings.length === 0) continue;

    for (const f of ch.findings) {
      ruleIds.add(f.ruleId);
      const builder = new SarifResultBuilder(f.ruleId, f.message)
        .withSeverity(f.severity);
      if (f.filePath) builder.withLocation(f.filePath, f.line, f.column);
      if (f.suggestion) builder.withSuggestion(f.suggestion);
      results.push(builder.build());
    }
  }

  if (results.length === 0) return [];

  return [{
    tool: {
      driver: {
        name: TOOL_DRIVER_NAME,
        version: TOOL_DRIVER_VERSION,
        rules: [...ruleIds].map((id) => ({ id })),
      },
    },
    results,
  }];
}

function wrapSarifLog(runs: SarifRun[]): Record<string, unknown> {
  return { version: '2.1.0' as const, $schema: SARIF_SCHEMA, runs };
}

/**
 * Split SARIF runs into chunks of at most `maxFindings` findings each.
 * Keeps whole runs together when possible; splits a single run across
 * chunks only when it exceeds the limit on its own.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- chunk packer: flush-current vs split-large branches reflect the two shapes the loop must handle
export function chunkSarifRuns(runs: SarifRun[], maxFindings = MAX_FINDINGS_PER_CHUNK): SarifRun[][] {
  if (runs.length === 0) return [];

  const chunks: SarifRun[][] = [];
  let currentChunk: SarifRun[] = [];
  let currentCount = 0;

  for (const run of runs) {
    if (run.results.length <= maxFindings && currentCount + run.results.length <= maxFindings) {
      // Whole run fits in current chunk
      currentChunk.push(run);
      currentCount += run.results.length;
    } else if (run.results.length <= maxFindings) {
      // Whole run fits, but not in current chunk — start a new one
      if (currentChunk.length > 0) chunks.push(currentChunk);
      currentChunk = [run];
      currentCount = run.results.length;
    } else {
      // Run exceeds max — flush current chunk, then split this run
      if (currentChunk.length > 0) chunks.push(currentChunk);
      currentChunk = [];
      currentCount = 0;

      for (let i = 0; i < run.results.length; i += maxFindings) {
        const slice = run.results.slice(i, i + maxFindings);
        const ruleIds = new Set(
          slice.map((r) => r.ruleId).filter((id): id is string => typeof id === 'string'),
        );
        chunks.push([{
          tool: {
            driver: {
              ...run.tool.driver,
              rules: [...ruleIds].map((id) => ({ id })),
            },
          },
          results: slice,
        }]);
      }
    }
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

/** Uploads SARIF runs to OpenSIP Cloud in chunks via the shared egress transport; returns aggregate result. */
export async function reportToCloud(output: CliOutput, url: string, apiKey?: string): Promise<ReportResult> {
  const allRuns = buildSarifRuns(output);
  if (allRuns.length === 0) {
    return { url, findingCount: 0, runCount: 0, success: true };
  }

  const sarifUrl = url.endsWith('/sarif') ? url : `${url}/sarif`;
  const cwd = process.cwd();
  /* v8 ignore next -- process.cwd() always returns a non-empty string in our supported runtimes; the empty-cwd branch is defensive */
  const target = cwd ? `${sarifUrl}?cwd=${encodeURIComponent(cwd)}` : sarifUrl;
  const totalFindings = allRuns.reduce((n, r) => n + r.results.length, 0);

  const rawChunks = chunkSarifRuns(allRuns);
  const findingsPer = rawChunks.map((c) => c.reduce((n, r) => n + r.results.length, 0));
  const bodies = rawChunks.map((c) => wrapSarifLog(c));
  const reportRunId = generatePrefixedId('rpt');

  const result = await postChunked({
    url: target,
    apiKey,
    chunks: bodies,
    idempotencyKeyFor: (i) => `${reportRunId}:${i}`,
    // 60s base + 100ms per finding — the receiver does per-finding work (dedup, persistence, traces).
    timeoutFor: (_chunk, i) => Math.min(300_000, 60_000 + findingsPer[i] * 100),
    policy: { maxAttempts: 3, overallDeadlineMs: 300_000, honorRetryAfter: true },
    evtPrefix: 'cli.report',
  });

  return {
    url: sarifUrl,
    findingCount: totalFindings,
    runCount: allRuns.length,
    success: result.outcome === 'ok',
    error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    chunksTotal: rawChunks.length,
    chunksSucceeded: result.acceptedChunks,
  };
}
