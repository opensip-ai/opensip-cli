import { withRetry, logger } from '@opensip-tools/core';

import type { SarifResult, SarifLocation, SarifFix } from './sarif/types.js';
import type { CliOutput } from '@opensip-tools/contracts';

const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';
const MAX_FINDINGS_PER_CHUNK = 500;

/** Logger module tag used by every event emitted from SARIF upload. */
const MODULE_TAG = 'cli:report';

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
 * type-aligned with the consumer (`gate.ts extractViolationsFromSarif`)
 * by routing every result through the shared `SarifResult` interface.
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

  withFix(suggestion: string): this {
    if (!suggestion) return this;
    const fix: SarifFix = { description: { text: suggestion } };
    this.result.fixes = [fix];
    return this;
  }

  build(): SarifResult {
    return this.result;
  }
}

/** Build a SARIF 2.1.0 log from CLI output — one run per check slug */
export function buildSarifLog(output: CliOutput): Record<string, unknown> {
  return wrapSarifLog(buildSarifRuns(output));
}

function buildSarifRuns(output: CliOutput): SarifRun[] {
  const runs: SarifRun[] = [];

  for (const ch of output.checks) {
    if (ch.findings.length === 0) continue;

    const ruleIds = new Set<string>();
    const results: SarifResult[] = [];

    for (const f of ch.findings) {
      ruleIds.add(f.ruleId);
      const builder = new SarifResultBuilder(f.ruleId, f.message)
        .withSeverity(f.severity);
      if (f.filePath) builder.withLocation(f.filePath, f.line, f.column);
      if (f.suggestion) builder.withFix(f.suggestion);
      results.push(builder.build());
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

  return runs;
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

/** True for errors where retrying later or with a different chunk may succeed */
function isTransientError(status: number): boolean {
  return status >= 500 || status === 429;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- network reporter: chunked uploads with per-chunk retries and aggregated error summary; phases read better inline
export async function reportToCloud(output: CliOutput, url: string, apiKey?: string): Promise<ReportResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const allRuns = buildSarifRuns(output);
  if (allRuns.length === 0) {
    return { url, findingCount: 0, runCount: 0, success: true };
  }

  const sarifUrl = url.endsWith('/sarif') ? url : `${url}/sarif`;
  const cwd = process.cwd();
  /* v8 ignore next -- process.cwd() always returns a non-empty string in our supported runtimes; the empty-cwd branch is defensive */
  const target = cwd ? `${sarifUrl}?cwd=${encodeURIComponent(cwd)}` : sarifUrl;
  const totalFindings = allRuns.reduce((n, r) => n + r.results.length, 0);

  const chunks = chunkSarifRuns(allRuns);
  const errors: string[] = [];
  let succeeded = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkFindings = chunk.reduce((n, r) => n + r.results.length, 0);
    // 60s base + 100ms per finding — receiver does per-finding work (dedup, persistence, traces)
    const timeoutMs = Math.min(300_000, 60_000 + chunkFindings * 100);
    const sarifLog = wrapSarifLog(chunk);

    logger.info({ evt: 'cli.report.chunk.start', module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, findings: chunkFindings, timeoutMs });

    try {
      const res = await withRetry(
        () => fetch(target, {
          method: 'POST',
          headers,
          body: JSON.stringify(sarifLog),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        {
          maxAttempts: 3,
          initialDelayMs: 500,
          maxDelayMs: 5000,
          onRetry: (attempt, error, delayMs) => {
            logger.info({
              evt: 'cli.report.retry',
              module: MODULE_TAG,
              attempt,
              error: error.message,
              delayMs,
              url: sarifUrl,
              chunk: `${ci + 1}/${chunks.length}`,
            });
          },
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const msg = `${res.status} ${res.statusText} ${body}`.trim();
        errors.push(msg);

        if (!isTransientError(res.status)) {
          // Non-transient (4xx) — no point sending remaining chunks
          logger.info({ evt: 'cli.report.abort', module: MODULE_TAG, reason: msg, remaining: chunks.length - ci - 1 });
          break;
        }
        continue;
      }

      succeeded++;
      logger.info({ evt: 'cli.report.chunk.done', module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, findings: chunkFindings });
    } catch (error) {
      // Network errors and timeouts are transient — continue with next chunk
      /* v8 ignore next -- fetch errors are always Error subclasses; the String(error) fallback is defensive */
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(errMsg);
      logger.info({ evt: 'cli.report.chunk.error', module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, error: errMsg });
    }
  }

  return {
    url: sarifUrl,
    findingCount: totalFindings,
    runCount: allRuns.length,
    success: errors.length === 0,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    chunksTotal: chunks.length,
    chunksSucceeded: succeeded,
  };
}
