// @fitness-ignore-file detached-promises -- CLI dispatch: render helpers are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file no-non-null-assertions -- narrowing helpers prove the discriminant before access; the assertions encode that proof for the type checker.
// @fitness-ignore-file throws-documentation -- internal CLI mode helper rethrows for the top-level handleGraphError; not a documented contract surface.
/**
 * @fileoverview Mode dispatch for `opensip-tools graph`.
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, isErrorSignal, logger, ToolError } from '@opensip-tools/core';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';
import { GraphBaselineRepo } from '../persistence/baseline-repo.js';
import { renderCatalogJson } from '../render/catalog-json.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Catalog, Indexes } from '../types.js';
import type { Signal, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

const MODULE_GRAPH_RENDER = 'graph:render';

export async function runGateMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
  resolutionMode?: 'exact' | 'fast',
): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) {
    throw new ConfigurationError('Graph gate mode requires a DataStore on ToolCliContext.');
  }
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
  const repo = new GraphBaselineRepo(datastore);
  if (opts.gateSave === true) {
    // ADR-0020: gate-save records the baseline AND hard-fails the step when the
    // current (already suppression-filtered, ADR-0014) signal set contains any
    // error-rung finding. `signals` reaching this mode is the post-`@graph-ignore`
    // `kept` set (see `cli/graph.ts:484`), so this counts UNSUPPRESSED findings
    // only. The error rung is core's canonical `isErrorSignal` (`critical`/`high`)
    // — the same predicate fit's `shouldFail`/`failOnErrors` threshold and graph's
    // own envelope verdict (`build-envelope.ts`) use, so all consumers agree on
    // what "error" means. The CI step (`pnpm graph:ci`) is therefore the honest
    // pass/fail signal — it no longer exits 0 while error-level graph findings
    // exist, so enforcement does not rely solely on the downstream Code Scanning
    // net-new ratchet + branch protection (the external config ADR-0017 declined
    // to trust). The SARIF export runs in a separate `if: always()` CI step, so
    // the baseline + net-new PR annotations survive a failed gate. Mirror of
    // `fit-modes.ts`'s gate-save branch.
    saveBaseline(signals, repo);
    const errorCount = signals.filter(isErrorSignal).length;
    const runFailed = errorCount > 0;
    cli.setExitCode(runFailed ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS);
    await cli.render({
      type: 'gate-done',
      lines: runFailed
        ? [
            `Graph baseline saved (${String(signals.length)} signals)`,
            `Graph gate FAILED: ${String(errorCount)} error-level finding(s) present.`,
          ]
        : [`Graph baseline saved (${String(signals.length)} signals)`],
    });
    return;
  }
  // gate-compare.
  //
  // ADR-0035 Phase 5 finding — RETAIN (not fold): `degraded` is "net-new findings
  // since the saved baseline", a baseline-DIFF predicate that is NOT expressible
  // over this run's own findings verdict (a run can have error-level findings yet
  // be `degraded: false` if none are net-new, and vice versa). So gate-compare
  // keeps its own exit here, distinct from the host's findings verdict. The host
  // does not clobber it: graph-command-spec re-affirms this already-set exit as
  // the `deliverSignals` runFailed override (via cli.getExitCode), and the run's
  // verdict headline stays informational for the gate-compare mode.
  const result = compareToBaseline(signals, repo);
  if (result.degraded) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    await cli.render({
      type: 'gate-done',
      lines: [
        `Graph gate FAILED: ${String(result.newSignals.length)} new finding(s) since baseline.`,
        ...result.newSignals.map((s) => `  + ${fingerprintSignal(s)}`),
      ],
    });
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
    await cli.render({
      type: 'gate-done',
      lines: [
        `Graph gate PASS: no regressions (${String(result.resolvedFingerprints.length)} resolved since baseline).`,
      ],
    });
  }
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
  // Defensively create the parent dir before writing — siblings
  // `runSarifExportMode` and `exportGraphBaseline` do the same. The
  // opensip `EngineSubprocessPort.runCatalogExport` may point
  // `--catalog-output` at a run-scoped temp dir that doesn't exist yet,
  // so a bare writeFileSync would throw ENOENT.
  mkdirSync(dirname(opts.catalogOutput!), { recursive: true });
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
