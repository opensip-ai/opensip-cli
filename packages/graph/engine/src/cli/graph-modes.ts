/**
 * @fileoverview Mode dispatch for `opensip-tools graph`.
 *
 * Extracted from `cli/graph.ts` so the orchestrator there stays focused
 * on flag validation, run-scope resolution, and result dispatch. Owns:
 *
 *  - `runGateMode` (--gate-save / --gate-compare)
 *  - `runReportMode` (--report-to)
 *  - `runCatalogJsonMode` (--catalog-output)
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { EXIT_CODES } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  logger,
  ToolError,
} from '@opensip-tools/core';
import { reportToCloud } from '@opensip-tools/fitness';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';
import { GraphBaselineRepo } from '../persistence/baseline-repo.js';
import { renderCatalogJson } from '../render/catalog-json.js';
import { buildCliOutput } from '../render/json.js';
import { renderSarif } from '../render/sarif.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Catalog, Indexes } from '../types.js';
import type { Signal, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

const MODULE_GRAPH_RENDER = 'graph:render';

export async function runGateMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) {
    throw new ConfigurationError('Graph gate mode requires a DataStore on ToolCliContext.');
  }
  const repo = new GraphBaselineRepo(datastore);
  if (opts.gateSave === true) {
    saveBaseline(signals, repo);
    process.stdout.write(`Graph baseline saved (${String(signals.length)} signals)\n`);
    cli.setExitCode(EXIT_CODES.SUCCESS);
    return;
  }
  // gate-compare
  const result = compareToBaseline(signals, repo);
  if (result.degraded) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stdout.write(
      `Graph gate FAILED: ${String(result.newSignals.length)} new finding(s) since baseline.\n`,
    );
    for (const s of result.newSignals) {
      process.stdout.write(`  + ${fingerprintSignal(s)}\n`);
    }
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
    process.stdout.write(
      `Graph gate PASS: no regressions (${String(result.resolvedFingerprints.length)} resolved since baseline).\n`,
    );
  }
  // Defer-await is fine; nothing else to do.
  await Promise.resolve();
}

export async function runReportMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const cliOutput = buildCliOutput(signals, 'graph');
  const url = opts.reportTo!;
  // toolVersion tracks @opensip-tools/graph package.json's version. Manually
  // synced — bump alongside any package.json version change. A future
  // build-time constant via tsc plugin or import-assertion would remove this
  // drift risk; not warranted for a single call site.
  const sarif = renderSarif(signals, {
    tool: 'opensip-tools-graph',
    toolVersion: '2.0.0',
  });
  const result = await reportToCloud(cliOutput, url, opts.apiKey);
  if (!result.success) {
    cli.setExitCode(EXIT_CODES.REPORT_FAILED);
    process.stderr.write(`Graph report failed: ${result.error ?? 'unknown error'}\n`);
    return;
  }
  cli.setExitCode(EXIT_CODES.SUCCESS);
  process.stdout.write(
    `Graph report sent to ${url} (${String(signals.length)} signals, ${sarif.length} bytes).\n`,
  );
}

/**
 * Catalog-JSON emission mode (Phase 3 Task 3.4 per opensip DEC-498).
 * Walks the engine's `Catalog` + `Indexes`, derives opensip-compatible
 * symbol/edge IDs, and writes a `CatalogExport` JSON document to the
 * `--catalog-output <path>` file. Phase 6's `EngineSubprocessPort`
 * invokes this mode per commit-sync run.
 *
 * Synchronous file write — catalog payloads are bounded (per-package
 * fan-out limits per-run scope) and we want backpressure if disk is
 * full rather than a deferred-write surprise.
 */
export function runCatalogJsonMode(
  opts: GraphCommandOptions,
  result: {
    readonly catalog: Catalog | null;
    readonly indexes: Indexes | null;
    readonly signals: readonly Signal[];
    readonly cacheHit: boolean;
  },
  cli: ToolCliContext,
  startedAt: string,
): void {
  if (typeof opts.tenantId !== 'string' || opts.tenantId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --tenant-id <id>.');
  }
  if (typeof opts.repoId !== 'string' || opts.repoId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --repo-id <id>.');
  }
  if (typeof opts.gitSha !== 'string' || opts.gitSha.length === 0) {
    throw new ConfigurationError('--catalog-output requires --git-sha <sha>.');
  }
  if (result.catalog === null || result.indexes === null) {
    throw new ToolError(
      'Cannot emit catalog-json: engine returned null catalog / indexes (no parseable input).',
      'GRAPH.CATALOG_JSON.NULL_CATALOG',
    );
  }

  const runId = opts.runId ?? randomUUID();
  const completedAt = new Date().toISOString();
  // Caller (opensip-side EngineSubprocessPort, Phase 6) inspects the
  // file's existence + completeness field; engine never emits 'partial'
  // from this code path (the engine's pressure-monitor / abort-handling
  // bypass this function entirely on failure). A future task may add
  // partial-completion semantics by catching MemoryPressureError in
  // executeGraph and writing a partial CatalogExport here.
  const provenance = {
    runId,
    completeness: 'complete' as const,
    engineVersion: '2.0.0',
    startedAt,
    completedAt,
    tenantId: opts.tenantId,
  };

  logger.info({
    evt: 'graph.render.catalog_json.start',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.catalogOutput,
  });
  const json = renderCatalogJson({
    catalog: result.catalog,
    indexes: result.indexes,
    provenance,
    repoId: opts.repoId,
    gitSha: opts.gitSha,
  });
  writeFileSync(opts.catalogOutput!, json);
  logger.info({
    evt: 'graph.render.catalog_json.complete',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.catalogOutput,
    bytes: json.length,
    cacheHit: result.cacheHit,
    signalCount: result.signals.length,
  });
  cli.setExitCode(EXIT_CODES.SUCCESS);
}
