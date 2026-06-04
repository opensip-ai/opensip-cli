// @fitness-ignore-file error-handling-quality -- CLI output baseline-write at line 396 is best-effort by design ("don't fail the run"); the comment + v8-ignore at the catch already document that user-visible behavior is unaffected if the persistence layer hiccups.
// @fitness-ignore-file detached-promises -- CLI renderers (process.stdout.write, render helpers, log lines, setExitCode) are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file module-coupling-fan-out -- composition root: the main graph command handler wires detection, orchestration, reporting, workspace, persistence, and recipe resolution; high intra-project fan-out is inherent to a CLI entry point (cf. the index.ts / code-paths.ts barrels that suppress the same check).
// @fitness-ignore-file performance-anti-patterns -- spread in CLI report aggregation iterates bounded result sets (rule counts, entry-point lists).
// @fitness-ignore-file no-markdown-references -- docs/plans/* pointers in JSDoc are stable internal references.
// @fitness-ignore-file public-api-jsdoc -- GraphCommandOptions interface and executeGraph are already documented with rich JSDoc on each field; the check counts the top-level export line, not the fields.
// @fitness-ignore-file file-length-limit -- top-level graph command handler with rich JSDoc on options; splitting would fragment the unified subcommand surface (gate/persist/output dispatch).
/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline and prints a comprehensive report covering
 * rules, entry points, and catalog summary in one invocation. Per
 * DEC-8, a switch in this handler dispatches to the right renderer.
 *
 * CLI shape (language-neutral):
 *   - `graph` — whole project, auto-detected language(s)
 *   - `graph <path> [<path>...]` — scope to one or more subtrees
 *   - `graph --workspace` — fan out across detected workspace units
 *     (polyglot: aggregates every adapter's units per spec D8b)
 *   - `graph --language <name>` — force a single adapter
 *
 * History: v0.2 originally split this into three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The two filtered views are
 * now sections in this unified report. The TS-flavored `--package` /
 * `--packages` flags were retired in favor of the polyglot surface
 * above; see docs/plans/graph-cli-language-neutral-scoping/.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  generatePrefixedId,
  logger,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';
import { emitRunSignals } from '@opensip-tools/reporting';
import { SessionRepo } from '@opensip-tools/session-store';

import { pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { buildGraphSessionPayload } from '../persistence/session-payload.js';
import { resolveRecipeToRules } from '../recipes/resolve.js';
import { buildCliOutput, buildCliOutputFromFindings, renderJson } from '../render/json.js';


import { detectLanguages } from './detect.js';
import { runCatalogJsonMode, runGateMode, runReportMode } from './graph-modes.js';
import { buildUnifiedReportLines, countFiles, resolutionBannerText } from './graph-report.js';
import { loadGraphConfig, runGraph, runShardedGraph } from './orchestrate.js';
import { positionalPathLabel, resolvePositionalPaths } from './positional-paths.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { renderWorkspaceJson, writeWorkspaceReport } from './workspace-report.js';
import { discoverPolyglotUnits, runWorkspaceUnitsInParallel } from './workspace-runner.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Shard } from './orchestrate/shard-model.js';
import type { RunGraphResult } from './orchestrate.js';
import type { Catalog, FeatureColumn, GraphConfig, Rule } from '../types.js';
import type { FindingOutput, GraphDoneResult } from '@opensip-tools/contracts';
import type { LanguageAdapter, Signal, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

// Re-exports kept so the package barrel + cli/graph-runner.tsx + tests
// keep using `cli/graph.js` as a single import site for these shapes.
export type { GraphCommandOptions } from './graph-options.js';
export { buildUnifiedReportLines } from './graph-report.js';
export type { UnifiedReportInput } from './graph-report.js';

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';
const MODULE_GRAPH_RENDER = 'graph:render';

/**
 * The feature columns the decoupled dashboard renders (ADR-0006): only these
 * are materialized into the persisted catalog, and only on the standard
 * (catalog-producing) `graph` run. Export-only paths (sarif/catalog export)
 * do not go through this dispatch, so they stay lean (no features persisted).
 */
const DASHBOARD_FEATURE_COLUMNS: readonly FeatureColumn[] = ['blast', 'scc', 'packageCoupling'];

export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.graph.start', module: MODULE_GRAPH_CLI, cwd: opts.cwd });
  const startedAt = new Date().toISOString();
  try {
    validateMutuallyExclusiveFlags(opts);
    // Resolve `--recipe` once at the top of the run (CLI layer owns
    // selection; the engine stays recipe-agnostic). Threaded into every
    // build path as `RunGraphInput.rules`. An unknown name throws a
    // ConfigurationError here, caught below by handleGraphError. For the
    // `--workspace` path the parent resolves only to validate the name
    // (fail-fast); children re-resolve `--recipe` in their own scope.
    const rules = resolveRecipeToRules(opts.recipe);
    if (opts.workspace === true) {
      await executeWorkspaceGraph(opts, cli);
      return;
    }
    const positionalPaths = resolvePositionalScope(opts);
    if (positionalPaths.length > 1) {
      await executeMultiPathGraph(opts, positionalPaths, cli, startedAt, rules);
      return;
    }
    const runCwd = positionalPaths[0] ?? opts.cwd;
    // Honor the project's `graph:` config block (rule knobs like
    // minCrossPackageDuplicatePackages). Resolved from the original cwd so a
    // positional subtree run still picks up the project-root config.
    const config = loadGraphConfig(opts.cwd);
    // Auto-shard a multi-package project (bare `graph`, no explicit subtree):
    // build packages in parallel and recover cross-package edges. Falls back
    // to the single-process build for one-package repos or when sharding
    // can't engage (no worker script, discovery failure).
    const shards = positionalPaths.length === 0 ? await resolveShards(opts, cli) : [];
    const result = shards.length > 1
      ? await runShardedBuild(opts, shards, runCwd, cli, config, rules)
      : await runGraph({
          cwd: runCwd,
          noCache: opts.noCache,
          resolution: opts.resolution,
          language: opts.language,
          config,
          rules,
          datastore: cli.scope.datastore() as DataStore | undefined,
          emitFeatures: DASHBOARD_FEATURE_COLUMNS,
        });
    enforceLanguageMismatchPolicy(opts, result.catalog, [runCwd]);
    await dispatchGraphResult(opts, result, cli, startedAt);
  } catch (error) {
    handleGraphError('graph', error, cli);
  }
}

/**
 * Resolve a project to its shards (one per workspace package). Returns an
 * empty array — signalling the caller to use the single-process build —
 * when the project isn't multi-package, when no worker script is
 * available to spawn, or when discovery fails. Each unit's file set is
 * enumerated via the graph adapter; partitions with no files are dropped.
 */
async function resolveShards(opts: GraphCommandOptions, cli: ToolCliContext): Promise<Shard[]> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) return [];

  let units: readonly { id: string; rootDir: string; configPath?: string }[];
  try {
    units = await discoverPolyglotUnits(opts.cwd, resolveAdaptersForRun(opts, cli));
  } catch {
    /* v8 ignore next */
    return [];
  }
  if (units.length <= 1) return [];

  const adapter = pickAdapter(opts.cwd);
  const shards: Shard[] = [];
  for (const unit of units) {
    let files: readonly string[];
    let configPathAbs: string | undefined;
    try {
      const disc = adapter.discoverFiles({ cwd: unit.rootDir, configPathOverride: unit.configPath });
      files = disc.files;
      configPathAbs = unit.configPath ?? disc.configPathAbs;
    } catch {
      continue; // a unit the graph adapter can't discover is skipped, not fatal
    }
    if (files.length > 0) shards.push({ id: unit.id, rootDir: unit.rootDir, files, configPathAbs });
  }
  // Need at least two non-empty shards to justify the parallel/merge overhead.
  return shards.length > 1 ? shards : [];
}

/** Drive the sharded build and adapt it to the RunGraphResult dispatch shape. */
async function runShardedBuild(
  opts: GraphCommandOptions,
  shards: readonly Shard[],
  projectRoot: string,
  cli: ToolCliContext,
  config: GraphConfig,
  rules: readonly Rule[],
): Promise<RunGraphResult> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  const sharded = await runShardedGraph({
    shards,
    projectRoot,
    cliScript: opts.cliScript ?? process.argv[1] ?? '',
    adapter: pickAdapter(projectRoot),
    resolutionMode: opts.resolution ?? 'exact',
    concurrency: opts.concurrency,
    useCache: opts.noCache !== true,
    config,
    rules,
    catalogRepo: datastore ? new CatalogRepo(datastore) : null,
    emitFeatures: DASHBOARD_FEATURE_COLUMNS,
  });
  return {
    catalog: sharded.catalog,
    indexes: sharded.indexes,
    signals: sharded.signals,
    resolutionStats: sharded.resolutionStats,
    cacheHit: sharded.cacheHit,
    features: sharded.features,
  };
}

function validateMutuallyExclusiveFlags(opts: GraphCommandOptions): void {
  if (opts.gateSave === true && opts.gateCompare === true) {
    throw new ConfigurationError('--gate-save and --gate-compare are mutually exclusive.');
  }
  if (opts.workspace === true && (opts.paths?.length ?? 0) > 0) {
    throw new ConfigurationError(
      '--workspace and positional paths are mutually exclusive. Use one or the other.',
    );
  }
}

function resolvePositionalScope(opts: GraphCommandOptions): readonly string[] {
  if (!opts.paths || opts.paths.length === 0) return [];
  return resolvePositionalPaths(opts.paths, opts.cwd);
}

/**
 * D14 mixed policy. When `--language X` was specified and the run
 * discovered zero files matching that adapter, exit 2 with the
 * canonical error. Auto-detection paths (no `--language`) do NOT
 * trigger this check — a "zero files" outcome there is a valid
 * (non-error) state.
 */
function enforceLanguageMismatchPolicy(
  opts: GraphCommandOptions,
  catalog: Catalog | null,
  paths: readonly string[],
): void {
  if (typeof opts.language !== 'string' || opts.language.length === 0) return;
  const fileCount = catalog === null ? 0 : countFiles(catalog);
  if (fileCount > 0) return;
  const pathLabel = paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ');
  throw new ConfigurationError(
    `--language ${opts.language} matched 0 files under ${pathLabel}; check the flag or paths.`,
  );
}

async function executeMultiPathGraph(
  opts: GraphCommandOptions,
  paths: readonly string[],
  cli: ToolCliContext,
  startedAt: string,
  rules: readonly Rule[],
): Promise<void> {
  const allSignals: Signal[] = [];
  let combinedFiles = 0;
  let lastResult: Awaited<ReturnType<typeof runGraph>> | null = null;
  const config = loadGraphConfig(opts.cwd);
  for (const p of paths) {
    const r = await runGraph({
      cwd: p,
      noCache: opts.noCache,
      resolution: opts.resolution,
      language: opts.language,
      config,
      rules,
      datastore: cli.scope.datastore() as DataStore | undefined,
      emitFeatures: DASHBOARD_FEATURE_COLUMNS,
    });
    lastResult = r;
    allSignals.push(...r.signals);
    if (r.catalog !== null) combinedFiles += countFiles(r.catalog);
  }
  // D14: count files across every analyzed path. Zero files + a
  // `--language` override → exit 2 with the canonical message.
  if (
    typeof opts.language === 'string'
    && opts.language.length > 0
    && combinedFiles === 0
  ) {
    throw new ConfigurationError(
      `--language ${opts.language} matched 0 files under ${paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ')}; check the flag or paths.`,
    );
  }
  /* v8 ignore next */
  if (lastResult === null) return;
  const combined = {
    catalog: lastResult.catalog,
    indexes: lastResult.indexes,
    signals: allSignals as readonly Signal[],
    resolutionStats: lastResult.resolutionStats,
    cacheHit: lastResult.cacheHit,
    features: lastResult.features,
  };
  await dispatchGraphResult(opts, combined, cli, startedAt);
}

// Exported for the per-mode signal-emit test (audit P1-2). Not re-exported by
// the package barrel (only `executeGraph` is), so it stays package-internal.
export async function dispatchGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
  startedAt: string,
): Promise<void> {
  if (opts.gateSave === true || opts.gateCompare === true) {
    // Gate output and the best-effort cloud emit are independent (the emit is a
    // no-op for the keyless majority) — run them concurrently.
    await Promise.all([
      runGateMode(opts, result.signals, cli, result.catalog?.resolutionMode),
      emitGraphSignals(opts, result, cli),
    ]);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  if (typeof opts.reportTo === 'string' && opts.reportTo.length > 0) {
    await Promise.all([
      runReportMode(opts, result.signals, cli),
      emitGraphSignals(opts, result, cli),
    ]);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    runCatalogJsonMode(opts, result, cli, startedAt);
    await emitGraphSignals(opts, result, cli);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  await renderGraphResult(opts, result, startedAt, cli);
  // Session persistence is dashboard history — populated on human-facing runs
  // only. `--json` is the machine-artifact mode AND the carrier each
  // `executeWorkspaceGraph` child runs under; skipping the session write here
  // keeps "one human invocation = one session" (the --workspace parent persists
  // the single aggregate row).
  if (opts.json !== true) {
    const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
    persistSession(opts, result.signals, cli.scope.datastore() as DataStore | undefined, durationMs);
    // Cloud signal emit is now decoupled from session persistence (audit P1-2)
    // and also runs in the gate/report/catalog branches above. Plain `--json`
    // stays excluded so workspace child processes don't each emit; the parent
    // aggregates findings for the dashboard but does not emit cloud signals.
    await emitGraphSignals(opts, result, cli);
  }
  cli.setExitCode(EXIT_CODES.SUCCESS);
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
  });
}

/**
 * Best-effort cloud signal emit for a graph run (ADR-0008), decoupled from
 * session persistence so it fires in every documented single-run mode — gate,
 * report, catalog, and the default render — not only the dashboard-populating
 * path (audit P1-2). No-op for the keyless / not-entitled majority; never
 * throws. Plain `--json` and `--workspace` deliberately do not emit (see the
 * call sites): `--json` is the workspace-child carrier, and the workspace
 * parent aggregates findings for the dashboard, not signals for the cloud.
 */
async function emitGraphSignals(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
): Promise<void> {
  await emitRunSignals({
    output: buildCliOutput(result.signals, 'graph', result.catalog?.resolutionMode),
    tool: 'graph',
    recipe: opts.recipe,
    cwd: opts.cwd,
    signalSink: cli.scope.signalSink,
  });
}

/**
 * Next-step hint strip for the default (non-verbose) graph report. Kept
 * identical to the Ink live view's `RunFooterHints` (graph-runner.tsx) so
 * the report reads the same whether it came from the live view or this
 * non-interactive path.
 */
const GRAPH_FOOTER_HINTS: readonly { readonly text: string; readonly bold?: readonly string[] }[] = [
  { text: 'Use --verbose for detailed results', bold: ['--verbose'] },
  { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
  { text: '--report-to <url> to send to OpenSIP', bold: ['--report-to <url>'] },
];

async function renderGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  startedAt: string,
  cli: ToolCliContext,
): Promise<void> {
  if (opts.json === true) {
    logger.info({ evt: 'graph.render.json.start', module: MODULE_GRAPH_RENDER });
    const out = renderJson(result.signals, {
      cwd: opts.cwd,
      tool: 'graph',
      command: 'graph',
      resolutionMode: result.catalog?.resolutionMode,
    });
    process.stdout.write(`${out}\n`);
    logger.info({ evt: 'graph.render.json.complete', module: MODULE_GRAPH_RENDER });
    return;
  }
  logger.info({ evt: 'graph.render.table.start', module: MODULE_GRAPH_RENDER });
  // Mirror the Ink live-view surface: default shows summary + footer hint
  // only; `--verbose` opens up the catalog / findings-by-rule / entry-points
  // body. The result is handed to the central render seam, which renders it
  // as Ink (TTY) or plain text (pipe/CI) from one definition — no
  // hand-maintained plain-text copies of the summary/footer/banner.
  const verbose = opts.verbose === true;
  const cliOutput = buildCliOutput(result.signals, 'graph', result.catalog?.resolutionMode);
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const reportLines = verbose
    ? buildUnifiedReportLines(
        {
          catalog: result.catalog,
          indexes: result.indexes,
          signals: result.signals,
          cacheHit: result.cacheHit,
        },
        { includeSummary: false },
      )
    : [];
  const resolutionBanner = resolutionBannerText(result.catalog?.resolutionMode);
  const done: GraphDoneResult = {
    type: 'graph-done',
    reportLines,
    ...(resolutionBanner === undefined ? {} : { resolutionBanner }),
    summary: {
      passed: cliOutput.summary.passed,
      failed: cliOutput.summary.failed,
      errors: cliOutput.summary.errors,
      warnings: cliOutput.summary.warnings,
    },
    durationMs,
    footerHints: verbose ? [] : GRAPH_FOOTER_HINTS,
  };
  await cli.render(done);
  logger.info({ evt: 'graph.render.table.complete', module: MODULE_GRAPH_RENDER });
}

/**
 * `graph --workspace` — fan a graph run out across every workspace
 * unit returned by the adapters' `discoverWorkspaceUnits` hook. Per
 * spec D8b, polyglot repos aggregate units from EVERY detected
 * adapter (or the single adapter named by `--language`).
 */
async function executeWorkspaceGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--workspace: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const adapters = resolveAdaptersForRun(opts, cli);
  const units = await discoverPolyglotUnits(opts.cwd, adapters);
  if (units.length === 0) {
    const adapterLabel =
      adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip-tools graph' for whole-project analysis.`,
    );
  }

  const startedAt = Date.now();
  const result = await runWorkspaceUnitsInParallel({
    cwd: opts.cwd,
    units,
    cliScript,
    concurrency: opts.concurrency,
    noCache: opts.noCache,
    resolution: opts.resolution,
    recipe: opts.recipe,
  });
  const durationMs = Date.now() - startedAt;

  const allFindings: FindingOutput[] = [];
  for (const r of result.perUnit) allFindings.push(...r.findings);

  if (opts.json === true) {
    process.stdout.write(`${renderWorkspaceJson(result.perUnit, durationMs)}\n`);
  } else {
    await writeWorkspaceReport(result.perUnit, durationMs, cli);
    // Persist exactly one aggregate session for the whole --workspace
    // invocation. Matches the contract "one human-facing CLI invocation
    // = one session" that fitness/sim already follow; the per-unit
    // child processes don't persist because they always run with --json
    // (see dispatchGraphResult).
    //
    // Cloud signal sync (ADR-0008) is intentionally NOT emitted for
    // --workspace (audit P1-2): the parent aggregates per-unit findings for
    // the dashboard, not signals, and the --json children skip emit to avoid
    // fragmented per-unit batches. A whole-project `graph` run emits normally.
    persistWorkspaceSession(opts, allFindings, durationMs, cli);
  }

  // If any child failed to spawn or exited with an error, surface it
  // as a runtime error. The parent itself succeeded if every child
  // returned exit 0.
  if (result.anyChildFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph --workspace: at least one unit run failed; see per-unit output above.\n`,
    );
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
  }
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    units: result.perUnit.length,
    findings: allFindings.length,
    failed: result.anyChildFailed,
    durationMs,
  });
}

/**
 * Resolve which language adapters apply to this run. With `--language`
 * set, returns exactly that adapter (errors if unregistered). Without
 * it, runs marker-based detection and returns every adapter the repo
 * exposes a marker for (polyglot per spec D6).
 */
function resolveAdaptersForRun(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): readonly LanguageAdapter[] {
  const registry = cli.scope.languages;
  if (typeof opts.language === 'string' && opts.language.length > 0) {
    const canonical = registry.canonicalize(opts.language) ?? opts.language;
    const adapter = registry.get(canonical);
    if (!adapter) {
      throw new ConfigurationError(
        `--language '${opts.language}' is not a registered adapter.`,
      );
    }
    return [adapter];
  }
  const detection = detectLanguages(opts.cwd, registry);
  const adapters: LanguageAdapter[] = [];
  for (const id of detection.adapterIds) {
    const adapter = registry.get(id);
    /* v8 ignore next */
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}


/**
 * Persist one graph session after a non-opt-out run. Exported so the
 * live-view orchestrator (`graph-runner.tsx`) can call it on its own
 * success transition — the dispatch-path orchestrator (`executeGraph`)
 * and the live-view path are parallel today, so both call this
 * directly. A future cleanup should consolidate the post-run
 * finalization into a single shared helper rather than two call sites.
 */
export function persistSession(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  datastore: DataStore | undefined,
  durationMs: number,
): void {
  if (!datastore) return;
  saveGraphSession(opts, buildCliOutput(signals, 'graph', undefined, durationMs), datastore);
}

function persistWorkspaceSession(
  opts: GraphCommandOptions,
  findings: readonly FindingOutput[],
  durationMs: number,
  cli: ToolCliContext,
): void {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) return;
  saveGraphSession(opts, buildCliOutputFromFindings(findings, 'graph', durationMs), datastore);
}

function saveGraphSession(
  opts: GraphCommandOptions,
  cliOutput: ReturnType<typeof buildCliOutput>,
  datastore: DataStore,
): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('graph'),
      tool: 'graph',
      timestamp: cliOutput.timestamp,
      cwd: opts.cwd,
      score: cliOutput.score,
      passed: cliOutput.passed,
      durationMs: cliOutput.durationMs,
      // Graph-owned opaque detail: summary + rule-grouped per-signal
      // findings (the same rule grouping graph already computes for its
      // JSON/SARIF surfaces). The generic session row holds zero graph
      // vocabulary; the dashboard reads this blob structurally.
      payload: buildGraphSessionPayload(cliOutput),
    });
  } catch {
    /* v8 ignore next */
    // best effort; don't fail the run
  }
}

export function handleGraphError(label: string, error: unknown, cli: ToolCliContext): void {
  logger.error({
    evt: `graph.cli.${label}.error`,
    module: MODULE_GRAPH_CLI,
    err: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof ConfigurationError) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  } else {
    /* v8 ignore start */
    if (error instanceof ValidationError) {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    } else if (error instanceof MemoryPressureError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else if (error instanceof ToolError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    }
    /* v8 ignore stop */
  }
  process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
}

