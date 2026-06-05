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

import { EXIT_CODES, passRate } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  currentScope,
  generatePrefixedId,
  logger,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';
import { SessionRepo } from '@opensip-tools/session-store';

import { pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { buildGraphSessionPayload } from '../persistence/session-payload.js';
import { resolveRecipeToRules } from '../recipes/resolve.js';
import { mapOpenSipRuleIdToEngineSlug } from '../render/rule-id-mapping.js';

import { buildGraphEnvelope } from './build-envelope.js';
import { detectLanguages } from './detect.js';
import { runCatalogJsonMode, runGateMode } from './graph-modes.js';
import { buildUnifiedReportLines, countFiles, resolutionBannerText } from './graph-report.js';
import { loadGraphConfig, runGraph, runShardedGraph } from './orchestrate.js';
import { positionalPathLabel, resolvePositionalPaths } from './positional-paths.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { buildWorkspaceJsonDocument, writeWorkspaceReport } from './workspace-report.js';
import { discoverPolyglotUnits, runWorkspaceUnitsInParallel } from './workspace-runner.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Shard } from './orchestrate/shard-model.js';
import type { RunGraphResult } from './orchestrate.js';
import type { Catalog, FeatureColumn, GraphConfig, Rule } from '../types.js';
import type { GraphDoneResult, SignalEnvelope } from '@opensip-tools/contracts';
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

/**
 * Run graph and return the run's {@link SignalEnvelope} so the composition
 * root can deliver it (cloud + `--report-to`, ADR-0011). Returns `undefined`
 * for the paths that do NOT produce a deliverable envelope: plain `--json`
 * (the `--workspace` child carrier — children must not each emit cloud
 * signals) and `--workspace` itself (the parent aggregates per-unit findings
 * for the dashboard, not signals for the cloud — audit P1-2), and any error
 * path. tool.ts calls `cli.deliverSignals` only when an envelope comes back.
 */
export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<SignalEnvelope | undefined> {
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
      return undefined;
    }
    const positionalPaths = resolvePositionalScope(opts);
    if (positionalPaths.length > 1) {
      return await executeMultiPathGraph(opts, positionalPaths, cli, startedAt, rules);
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
    return await dispatchGraphResult(opts, result, cli, startedAt);
  } catch (error) {
    handleGraphError('graph', error, cli);
    return undefined;
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
): Promise<SignalEnvelope | undefined> {
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
  if (lastResult === null) return undefined;
  const combined = {
    catalog: lastResult.catalog,
    indexes: lastResult.indexes,
    signals: allSignals as readonly Signal[],
    resolutionStats: lastResult.resolutionStats,
    cacheHit: lastResult.cacheHit,
    features: lastResult.features,
  };
  return await dispatchGraphResult(opts, combined, cli, startedAt);
}

/**
 * Assemble the run's {@link SignalEnvelope} from its raw engine signals
 * (ADR-0011). Centralises `runId`/`createdAt` resolution off the live scope so
 * cloud egress correlates with the run id the logger stamps; the envelope is
 * pure (the clock read happens here, once).
 */
function envelopeFor(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  durationMs: number,
): SignalEnvelope {
  return buildGraphEnvelope({
    signals: result.signals,
    recipe: opts.recipe,
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    durationMs,
    resolutionMode: result.catalog?.resolutionMode,
  });
}

// Exported for the per-mode dispatch test (audit P1-2). Not re-exported by
// the package barrel (only `executeGraph` is), so it stays package-internal.
//
// Returns the run's envelope for every mode that should deliver signals
// (gate, catalog, `--report-to`, default render) so the composition root can
// cloud-emit + report-to it ONCE (ADR-0011 / ADR-0008). Returns `undefined`
// for plain `--json` (the `--workspace` child carrier — children must not each
// emit cloud signals).
export async function dispatchGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
  startedAt: string,
): Promise<SignalEnvelope | undefined> {
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  if (opts.gateSave === true || opts.gateCompare === true) {
    await runGateMode(opts, result.signals, cli, result.catalog?.resolutionMode);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return envelopeFor(opts, result, durationMs);
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    runCatalogJsonMode(opts, result, cli, startedAt);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return envelopeFor(opts, result, durationMs);
  }
  const envelope = await renderGraphResult(opts, result, startedAt, cli);
  // Session persistence is dashboard history — populated on human-facing runs
  // only. Skipped for:
  //   - `--json` (the machine-artifact mode AND the carrier each
  //     `executeWorkspaceGraph` child runs under — keeps "one human invocation
  //     = one session"; the --workspace parent persists the single aggregate);
  //   - `--report-to` (an export mode; like gate/catalog it opts out of session
  //     history — the root delivers the envelope to the receiver instead).
  const isReportTo = typeof opts.reportTo === 'string' && opts.reportTo.length > 0;
  if (opts.json !== true && !isReportTo) {
    persistSession(opts, result.signals, cli.scope.datastore() as DataStore | undefined, durationMs);
  }
  cli.setExitCode(EXIT_CODES.SUCCESS);
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
  });
  // Plain `--json` is the workspace-child carrier: it returns `undefined` so
  // the root does not cloud-emit per child (the parent owns the dashboard
  // aggregate, not per-unit signal batches — audit P1-2). Every other mode
  // (default render, `--report-to`) returns the envelope for root delivery.
  return opts.json === true ? undefined : envelope;
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

/**
 * Render the run and return its {@link SignalEnvelope} (ADR-0011).
 *
 * `--json` emits the envelope through the shared `formatSignalJson`
 * (`cli.emitEnvelope`). The default/`--verbose` path hands a `graph-done`
 * result to the render seam (Ink on TTY, plain text in pipes/CI): graph's
 * report is richer than the neutral per-unit table — it carries the verbose
 * catalog/findings/entry-point body (`reportLines`), a fast-tier caveat
 * (`resolutionBanner`), the one-line PASS/FAIL `summary`, and next-step
 * `footerHints`. The summary counts are derived from the envelope's verdict so
 * `--json` and the human report agree; the envelope itself is NOT carried on
 * the result (it would route to the neutral unit table and drop graph's body),
 * but IS returned for the composition root's cloud + `--report-to` delivery.
 */
async function renderGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  startedAt: string,
  cli: ToolCliContext,
): Promise<SignalEnvelope> {
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const envelope = envelopeFor(opts, result, durationMs);
  if (opts.json === true) {
    logger.info({ evt: 'graph.render.json.start', module: MODULE_GRAPH_RENDER });
    cli.emitEnvelope(envelope);
    logger.info({ evt: 'graph.render.json.complete', module: MODULE_GRAPH_RENDER });
    return envelope;
  }
  logger.info({ evt: 'graph.render.table.start', module: MODULE_GRAPH_RENDER });
  const verbose = opts.verbose === true;
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
  const { summary } = envelope.verdict;
  const done: GraphDoneResult = {
    type: 'graph-done',
    reportLines,
    ...(resolutionBanner === undefined ? {} : { resolutionBanner }),
    summary: {
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      warnings: summary.warnings,
    },
    durationMs,
    footerHints: verbose ? [] : GRAPH_FOOTER_HINTS,
  };
  await cli.render(done);
  logger.info({ evt: 'graph.render.table.complete', module: MODULE_GRAPH_RENDER });
  return envelope;
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

  const allSignals: Signal[] = [];
  for (const r of result.perUnit) allSignals.push(...r.signals);

  if (opts.json === true) {
    // ADR-0011: emit through the CLI seam, not process.stdout directly.
    // cli.emitJson applies the same JSON.stringify(_, null, 2) + '\n'.
    cli.emitJson(buildWorkspaceJsonDocument(result.perUnit, durationMs));
  } else {
    await writeWorkspaceReport(result.perUnit, durationMs, cli);
    // Persist exactly one aggregate session for the whole --workspace
    // invocation. Matches the contract "one human-facing CLI invocation
    // = one session" that fitness/sim already follow; the per-unit
    // child processes don't persist because they always run with --json
    // (see dispatchGraphResult).
    //
    // Cloud signal sync (ADR-0008) is intentionally NOT emitted for
    // --workspace (audit P1-2): the parent aggregates per-unit signals for
    // the dashboard, not for the cloud, and the --json children skip emit to
    // avoid fragmented per-unit batches. A whole-project `graph` run emits
    // normally (the root's deliverSignals on the returned envelope).
    persistWorkspaceSession(opts, allSignals, durationMs, cli);
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
    findings: allSignals.length,
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
  // The single-process path holds the raw engine signals (engine slugs), so
  // the session payload's per-rule keys are engine slugs directly.
  saveGraphSession(opts, signals, durationMs, datastore);
}

function persistWorkspaceSession(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  durationMs: number,
  cli: ToolCliContext,
): void {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) return;
  // Child envelopes carry Option-A-mapped OpenSIP rule IDs; reverse-map back
  // to engine slugs so the aggregate session payload's per-rule metric columns
  // (keyed on engine slugs in the dashboard) keep working.
  const engineSignals = signals.map((s) => {
    const ruleId = mapOpenSipRuleIdToEngineSlug(s.ruleId);
    return { ...s, ruleId, source: ruleId };
  });
  saveGraphSession(opts, engineSignals, durationMs, datastore);
}

function saveGraphSession(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  durationMs: number,
  datastore: DataStore,
): void {
  try {
    // Graph-owned opaque detail: summary + rule-grouped per-signal findings
    // (engine slugs), built straight from the run's `Signal[]` (ADR-0011 — no
    // `CliOutput`). The generic session row holds zero graph vocabulary; the
    // dashboard reads this blob structurally.
    const payload = buildGraphSessionPayload(signals);
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('graph'),
      tool: 'graph',
      timestamp: new Date().toISOString(),
      cwd: opts.cwd,
      // Pass rate over passed/total rules — same definition fit uses (a
      // warnings-only run is all-rules-passed → 100). `passed` ⇔ no
      // error-severity (critical|high) signals.
      score: passRate(payload.summary),
      passed: payload.summary.errors === 0,
      durationMs,
      payload,
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

