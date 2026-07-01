/**
 * @fileoverview Mode dispatch for `opensip graph`.
 *
 * Extracted from `cli/graph.ts` so the orchestrator there stays focused
 * on flag validation, run-scope resolution, and result dispatch. Owns:
 *
 *  - `runGateMode` (--gate-save / --gate-compare)
 *  - `runCatalogJsonMode` (--catalog-output)
 *
 * `--report-to` (the old `runReportMode`) moved to the composition root in
 * ADR-0011 Phase 5: graph returns its `SignalEnvelope` and the root's
 * `deliverSignals` owns cloud egress + the `--report-to` SARIF upload.
 */

import { randomUUID } from 'node:crypto';

import { EXIT_CODES, runHostGateDispatch } from '@opensip-cli/contracts';
import {
  createToolLogger,
  ConfigurationError,
  isErrorSignal,
  readPackageVersion,
  ToolError,
} from '@opensip-cli/core';

import { graphFingerprintStrategy } from '../baseline-strategy.js';
import { renderCatalogJson } from '../render/catalog-json.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Catalog, Indexes } from '../types.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

const log = createToolLogger('graph:cli');

const MODULE_GRAPH_RENDER = 'graph:render';
const ENGINE_VERSION = readPackageVersion(import.meta.url);

export async function runGateMode(
  opts: GraphCommandOptions,
  envelope: SignalEnvelope,
  cli: ToolCliContext,
  resolutionMode?: 'exact' | 'fast',
): Promise<void> {
  // A fast catalog's edges are approximate (syntactic). Seeding the
  // security ratchet from them — or comparing against an exact baseline —
  // would let false orphans/regressions flip the gate. The gate's value
  // depends on edge fidelity, so fast mode is declined by default; the
  // user must re-run with --resolution exact to gate.
  if (resolutionMode === 'fast') {
    throw new ConfigurationError(
      'Graph gate refuses a fast (--resolution fast) catalog: its syntactic edges ' +
        'are approximate and must not seed or compare against the security gate. ' +
        'Re-run with --resolution exact to gate.',
    );
  }
  // The host owns persistence (BaselineRepo), the diff, AND the exit (ADR-0036 /
  // ADR-0035): graph hands the already-fingerprint-stamped envelope to the seams
  // and feeds its gate verdict to the host's `deliverSignals` runFailed override.
  // No tool `setExitCode` on the gate path — the host derives RUNTIME_ERROR.
  const deliverOpts = {
    cwd: opts.cwd,
    reportTo: opts.reportTo,
    apiKey: opts.apiKey,
  };
  await runHostGateDispatch({
    cli,
    tool: 'graph',
    envelope,
    mode: opts.gateSave === true ? 'save' : 'compare',
    deliver: deliverOpts,
    saveRunFailed: ({ envelope }) => envelope.signals.some(isErrorSignal),
    renderSaveLines: ({ envelope, runFailed }) => {
      const errorCount = envelope.signals.filter(isErrorSignal).length;
      return runFailed
        ? [
            `Graph baseline saved (${String(envelope.signals.length)} signals)`,
            `Graph gate FAILED: ${String(errorCount)} error-level finding(s) present.`,
          ]
        : [`Graph baseline saved (${String(envelope.signals.length)} signals)`];
    },
    renderCompareLines: ({ result }) =>
      result.degraded
        ? [
            `Graph gate FAILED: ${String(result.added.length)} new finding(s) since baseline.`,
            ...result.added.map((s) => `  + ${graphFingerprintStrategy.fingerprint(s)}`),
          ]
        : [
            `Graph gate PASS: no regressions (${String(result.resolved.length)} resolved since baseline).`,
          ],
  });
}

/**
 * Catalog-JSON emission mode (Phase 3 Task 3.4 per opensip DEC-498).
 * Walks the engine's `Catalog` + `Indexes`, derives opensip-compatible
 * symbol/edge IDs, and writes a `CatalogExport` JSON document to the
 * `--catalog-output <path>` file. Phase 6's `EngineSubprocessPort`
 * invokes this mode per commit-sync run.
 *
 * Backpressured atomic write through the host `cli.writeArtifact` seam —
 * catalog payloads are bounded (per-package fan-out limits per-run scope)
 * and the await holds the run until the locked temp+rename completes,
 * surfacing a full disk rather than a deferred-write surprise.
 */
export async function runCatalogJsonMode(
  opts: GraphCommandOptions,
  result: {
    readonly catalog: Catalog | null;
    readonly indexes: Indexes | null;
    readonly signals: readonly Signal[];
    readonly cacheHit: boolean;
  },
  cli: ToolCliContext,
  startedAt: string,
): Promise<void> {
  if (typeof opts.tenantId !== 'string' || opts.tenantId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --tenant-id <id>.');
  }
  if (typeof opts.repoId !== 'string' || opts.repoId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --repo-id <id>.');
  }
  if (typeof opts.gitSha !== 'string' || opts.gitSha.length === 0) {
    throw new ConfigurationError('--catalog-output requires --git-sha <sha>.');
  }
  const catalogOutput = opts.catalogOutput;
  if (typeof catalogOutput !== 'string' || catalogOutput.length === 0) {
    throw new ConfigurationError('--catalog-output requires a path.');
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
    engineVersion: ENGINE_VERSION,
    startedAt,
    completedAt,
    tenantId: opts.tenantId,
  };

  log.info({
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
  await cli.writeArtifact(catalogOutput, json);
  log.info({
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
