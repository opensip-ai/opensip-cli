// @fitness-ignore-file error-handling-quality -- CLI output baseline-write at line 396 is best-effort by design ("don't fail the run"); the comment + v8-ignore at the catch already document that user-visible behavior is unaffected if the persistence layer hiccups.
// @fitness-ignore-file detached-promises -- CLI renderers (process.stdout.write, render helpers, log lines, setExitCode) are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file module-coupling-fan-out -- composition root: the main graph command handler wires detection, orchestration, reporting, workspace, persistence, and recipe resolution; high intra-project fan-out is inherent to a CLI entry point (cf. the index.ts / code-paths.ts barrels that suppress the same check).
// @fitness-ignore-file performance-anti-patterns -- spread in CLI report aggregation iterates bounded result sets (rule counts, entry-point lists).
// @fitness-ignore-file no-markdown-references -- docs/plans/* pointers in JSDoc are stable internal references.
// @fitness-ignore-file public-api-jsdoc -- GraphCommandOptions interface and executeGraph are already documented with rich JSDoc on each field; the check counts the top-level export line, not the fields.
// @fitness-ignore-file file-length-limit -- top-level graph command handler with rich JSDoc on options; splitting would fragment the unified subcommand surface (gate/persist/output dispatch).
/**
 * `opensip graph` — main subcommand handler.
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

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { EXIT_CODES, passRate } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  currentScope,
  logger,
  SystemError,
  ToolError,
  ValidationError,
} from '@opensip-cli/core';

import { pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { buildGraphSessionPayload } from '../persistence/session-payload.js';
import { resolveRecipeToRules } from '../recipes/resolve.js';
import { mapOpenSipRuleIdToEngineSlug } from '../render/rule-id-mapping.js';
import { currentRules } from '../rules/registry.js';

import {
  assertFinalizedAcrossBoundary,
  finalizeGraphSignals,
  type FinalizedSignals,
} from './apply-suppressions.js';
import { buildGraphEnvelope } from './build-envelope.js';
import { runCatalogJsonMode, runGateMode } from './graph-modes.js';
import {
  buildLiveGraphOutput,
  buildUnifiedReportLines,
  countFiles,
  resolutionBannerText,
  type LiveGraphOutput,
} from './graph-report.js';
import { resolveCanonicalFileSet } from './orchestrate/canonical-file-set.js';
import {
  detectMonorepoLayout,
  partitionFlatRepo,
  selectStrategyForLayout,
} from './orchestrate/flat-monorepo-strategy.js';
import { partitionFilesIntoShards } from './orchestrate/partition-files.js';
import {
  loadGraphConfig,
  resolveGraphRecipeSelection,
  runGraph,
  runShardedGraph,
} from './orchestrate.js';
import { positionalPathLabel, resolvePositionalPaths } from './positional-paths.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { GraphProfileBuilder, writeGraphProfile } from './profile.js';
import { resolveAdaptersForRun } from './resolve-adapters.js';
import { buildWorkspaceJsonDocument, writeWorkspaceReport } from './workspace-report.js';
import { discoverPolyglotUnits, runWorkspaceUnitsInParallel } from './workspace-runner.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { Shard } from './orchestrate/shard-model.js';
import type { GraphProgressCallback, RunGraphResult } from './orchestrate.js';
import type { GraphProfileRunRecorder } from './profile.js';
import type {
  Catalog,
  FeatureColumn,
  GraphConfig,
  PartitionStrategy,
  ResolutionMode,
  Rule,
} from '../types.js';
import type { GraphDoneResult, SignalEnvelope, VerboseDetail } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext, ToolSessionContribution } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

// Re-exports kept so the package barrel + cli/graph-runner.tsx + tests
// keep using `cli/graph.js` as a single import site for these shapes.
export type { GraphCommandOptions } from './graph-options.js';

export type { UnifiedReportInput, LiveGraphOutput } from './graph-report.js';

/**
 * The result of a static graph run that the command handler returns to the
 * host (host-owned-run-timing Phase 3). Carries the run's deliverable
 * {@link SignalEnvelope} (for cloud + `--report-to` egress) plus the OPTIONAL
 * generic-session contribution the host run plane persists after the handler
 * resolves. `session` is present only on the human-facing render path (and the
 * `--workspace` aggregate); the export/carrier modes (`--json`, `--report-to`,
 * gate) return `{ envelope }` with no session — preserving "one human
 * invocation = one session".
 *
 * Graph never writes the generic `StoredSession` row itself: it builds the
 * contribution from BRANDED {@link FinalizedSignals} and hands it up; the host
 * stamps `startedAt`/`completedAt`/`durationMs`/`id` and performs the save.
 *
 * `envelope` is optional because the `--workspace` aggregate carries a
 * `session` (the one aggregate row the host persists) but NO deliverable
 * envelope — the parent aggregates per-unit findings for the dashboard, not
 * signals for the cloud (audit P1-2). The command handler's egress is guarded
 * on `outcome?.envelope`, so a session-only outcome cloud-emits nothing.
 */
export interface GraphRunOutcome {
  readonly envelope?: SignalEnvelope;
  readonly session?: ToolSessionContribution;
}

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
 * Run graph and return the run's {@link GraphRunOutcome} — the deliverable
 * {@link SignalEnvelope} (so the composition root can cloud + `--report-to`
 * deliver it, ADR-0011) plus the optional generic-session contribution the
 * host run plane persists (host-owned-run-timing Phase 3; graph never writes
 * the row itself). Returns `undefined` for the paths that do NOT produce a
 * deliverable envelope: plain `--json` (the `--workspace` child carrier —
 * children must not each emit cloud signals) and `--workspace` itself (the
 * parent aggregates per-unit findings for the dashboard, not signals for the
 * cloud — audit P1-2), and any error path. The `--workspace` path returns its
 * outcome through `executeWorkspaceGraph` so the host persists the single
 * aggregate session. tool.ts calls `cli.deliverSignals` only when an envelope
 * comes back.
 */
export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<GraphRunOutcome | undefined> {
  // Hoisted dummies for any remaining internal startedAt refs in non-session
  // profile/display code paths inside this file (the session ones were switched
  // to host record). Visible to all branches despite early returns.
  const startedAtForProfile = new Date().toISOString();
  const startedAt: string = startedAtForProfile;
  const profile = createProfileBuilder(opts, startedAtForProfile);

  logger.info({
    evt: 'graph.cli.graph.start',
    module: MODULE_GRAPH_CLI,
    cwd: opts.cwd,
    // Observability: which build engine the user requested. Sharded is the
    // default (ADR-0032), so a bare run requests `sharded`; `--exact` opts back
    // to the single-program engine. The RESOLVED engine (after shardability) is
    // logged at `graph.cli.graph.engine`.
    requestedEngine: opts.exact === true ? 'exact' : 'sharded',
  });
  // (profile / startedAtForProfile already declared at top of fn for branch visibility)
  try {
    validateMutuallyExclusiveFlags(opts);
    // Resolve the recipe once at the top of the run (CLI layer owns selection;
    // the engine stays recipe-agnostic). Tool-scoped (ADR-0022): precedence is
    // `--recipe` flag > `graph.recipe` > `default`.
    // Threaded into every build path as `RunGraphInput.rules`. An explicit
    // unknown name throws a ConfigurationError here (caught by handleGraphError);
    // a config-sourced unknown name falls back to `default` with a warning. For
    // the `--workspace` path the parent resolves only to validate the name
    // (fail-fast); children re-resolve in their own scope.
    const recipeSelection = resolveGraphRecipeSelection(opts.cwd, opts.recipe);
    const rules = resolveRecipeToRules(recipeSelection.name, {
      tolerant: recipeSelection.tolerant,
    });
    // Normalize opts.recipe to the RESOLVED name so the envelope/run-header,
    // dashboard sessions, and any `--workspace` children report what actually
    // ran. Pre-ADR-0022 the generic `mergeConfigDefaults` set opts.recipe from
    // config; that responsibility now lives here, tool-scoped — opts is the
    // request-scoped parsed-options bag the pre-action hook already augments, so
    // this is the single point that owns graph's recipe normalization.
    (opts as { recipe?: string }).recipe = recipeSelection.name;
    if (opts.workspace === true) {
      const outcome = await executeWorkspaceGraph(opts, cli, profile);
      writeProfileIfRequested(opts, profile);
      return outcome;
    }
    const positionalPaths = resolvePositionalScope(opts);
    if (positionalPaths.length > 1) {
      const outcome = await executeMultiPathGraph(
        { opts, cli, rules, startedAt, profile },
        positionalPaths,
      );
      writeProfileIfRequested(opts, profile);
      return outcome;
    }
    // Realpath the run root ONCE, before engine selection (F3 path parity). The
    // EXACT engine normalizes its project dir via realpathSync internally
    // (graph-typescript normalize-project-dir); the SHARDED worker derives
    // project-relative `code.file` paths against this `projectRoot`. Under a
    // symlinked cwd a RAW root would make the sharded paths gain `../..` prefixes
    // while exact stays canonical → the two engines emit different `code.file`,
    // and since the engine choice is environment-sensitive, a `--gate-save`
    // baseline written by one engine would flag everything new under the other.
    // Canonicalizing here (idempotent for non-symlinks) keeps both engines'
    // emitted paths byte-identical. Shard discovery already realpaths internally
    // (discoverFiles → normalizeProjectDir), so the shard files and this root now
    // share the same canonical base.
    const runCwd = realpathOrSelf(positionalPaths[0] ?? opts.cwd, opts.cwd);
    // Honor the project's `graph:` config block (rule knobs like
    // minCrossPackageDuplicatePackages). Resolved from the original cwd so a
    // positional subtree run still picks up the project-root config.
    const config = loadGraphConfig(opts.cwd);
    // Determinism (ADR-0033, superseding ADR-0032/0031): the build engine is
    // chosen by an explicit, deterministic policy — the SHARDED engine is the
    // DEFAULT (both engines resolve through one shared model — exact = the
    // 1-shard case — held equivalent by the directional soundness invariant +
    // completeness floor; ADR-0033), and
    // `--exact` opts OUT to the single-program engine. It is NOT chosen by
    // `process.stdout.isTTY` or on-disk discovery state, so a bare `graph` builds
    // the same catalog whether run in a terminal, piped, or under
    // `--gate-*`/`--json`. When the project can't shard (no worker script,
    // single-unit, discovery failure) we fall back to the exact engine — the
    // natural single-package/small-repo path — rather than failing.
    const resolution = await resolveEngineShards(opts, cli, positionalPaths);
    const shards = resolution.shards;
    logger.info({
      evt: 'graph.cli.graph.engine',
      module: MODULE_GRAPH_CLI,
      mode: shards.length > 1 ? 'sharded' : 'exact',
      requestedExact: opts.exact === true,
      shards: shards.length,
      reason: engineSelectionReason(opts, positionalPaths, shards.length > 1),
    });
    const profileRun = profile?.startRun({
      label: positionalPaths.length === 0 ? 'root' : positionalPathLabel(runCwd, opts.cwd),
      cwd: runCwd,
      mode: shards.length > 1 ? 'sharded' : 'single-process',
    });
    // The synthetic partitioner runs BEFORE the profile run recorder exists
    // (its `mode` label needs the shard count), so its wall time is measured
    // where it runs and recorded here (ADR-0045 measurement plane).
    if (resolution.partition !== undefined) {
      profileRun?.recordStage(
        'partition',
        resolution.partition.durationMs,
        resolution.partition.detail,
      );
    }
    const result =
      shards.length > 1
        ? await runProfiledShardedBuild(profileRun, {
            opts,
            shards,
            projectRoot: runCwd,
            cli,
            config,
            rules,
          })
        : await runGraph({
            cwd: runCwd,
            noCache: opts.noCache,
            resolution: opts.resolution,
            language: opts.language,
            config,
            rules,
            datastore: cli.scope.datastore() as DataStore | undefined,
            emitFeatures: DASHBOARD_FEATURE_COLUMNS,
            onProgress: profileRun?.onProgress,
          });
    profileRun?.finish(result);
    // Propagate shard failures so incomplete catalogs do not silently produce
    // baselines or pass --gate-compare (per-audit: failedShardIds was computed
    // but never surfaced to the gate or as a hard error).
    if (shards.length > 1) {
      const sharded = result as { failedShardIds?: readonly string[] };
      if (sharded.failedShardIds && sharded.failedShardIds.length > 0) {
        throw new SystemError(
          `Sharded graph build had ${sharded.failedShardIds.length} shard failure(s); ` +
            `catalog and any --gate-* / baseline artifacts are incomplete. ` +
            `See 'graph.sharded.shard_failed' log events for per-shard details.`,
          { code: 'GRAPH.SHARD.FAILURES' },
        );
      }
    }
    enforceLanguageMismatchPolicy(opts, result.catalog, [runCwd]);
    // `runCwd` (= positionalPaths[0] ?? opts.cwd) is the build root the signals
    // are relative to — the correct base for resolving `@graph-ignore` directive
    // files. For the sharded build it equals `projectRoot` passed above.
    const outcome = await dispatchGraphResult(opts, result, cli, startedAt, runCwd);
    writeProfileIfRequested(opts, profile);
    return outcome;
  } catch (error) {
    handleGraphError('graph', error, cli);
    return undefined;
  }
}

/**
 * Engine-selection policy (ADR-0033, superseding ADR-0032/0031). The SHARDED
 * engine is the DEFAULT — both engines resolve through one shared model (exact =
 * the 1-shard case), held equivalent by the directional soundness invariant +
 * completeness floor (`equivalence-repo-scale.test.ts` fixture +
 * `graph-equivalence-check` directional real-repo ratchet +
 * `resolution-completeness-floor.test.ts`; ADR-0033). Returns the shard
 * set whenever the project can actually shard (>1 non-empty shard); returns an
 * empty array (→ the EXACT single-program engine) when `--exact` is passed OR
 * the project isn't shardable (single-package / flat / discovery failure — the
 * natural exact fallback). The decision is a pure function of the parsed options
 * + the project's shardability — it never reads `process.stdout.isTTY`, so a
 * bare `graph` is deterministic across terminal / pipe / CI invocations.
 *
 * The exact engine is selected (returns `[]`) when:
 *   - `--exact` was passed (the explicit small-repo / oracle escape hatch);
 *   - positional `[paths...]` were given (subtree/multi-path runs are exact);
 *   - the project resolves to ≤1 non-empty shard (nothing to parallelize) or
 *     no worker script is available — a graceful fall-through to exact, the
 *     natural single-package path.
 */
/**
 * Resolve a path to absolute (a RELATIVE input resolves against `base` —
 * the command's `opts.cwd`, NOT `process.cwd()`, which may differ when the
 * CLI is hosted), then realpath it (follow symlinks) — the SAME normalization
 * the exact engine's `normalizeProjectDir` applies, so both engines see one
 * canonical run root (F3). Falls back to the absolute path if realpath fails
 * (e.g. the path doesn't exist yet — discovery reports the error downstream).
 * Idempotent on an already-canonical path.
 */
function realpathOrSelf(input: string, base: string): string {
  // `resolve(base, input)` returns `input` unchanged when it is already absolute.
  const absolute = resolve(base, input);
  try {
    return realpathSync(absolute);
  } catch {
    /* v8 ignore next */
    return absolute;
  }
}

/** Shard resolution + optional synthetic-partition timing (profile stage). */
interface ShardResolution {
  readonly shards: Shard[];
  readonly partition?: { readonly durationMs: number; readonly detail: string };
}

async function resolveEngineShards(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
  positionalPaths: readonly string[],
): Promise<ShardResolution> {
  if (opts.exact === true) return { shards: [] };
  if (positionalPaths.length > 0) return { shards: [] };
  return resolveShards(opts, cli);
}

/**
 * Human-readable explanation of the engine decision for the
 * `graph.cli.graph.engine` observability event. Pure; mirrors
 * {@link resolveEngineShards}'s branches.
 */
function engineSelectionReason(
  opts: GraphCommandOptions,
  positionalPaths: readonly string[],
  sharded: boolean,
): string {
  if (sharded) return 'sharded-default';
  if (opts.exact === true) return 'exact-opt-out';
  if (positionalPaths.length > 0) return 'exact-positional-paths';
  return 'exact-not-shardable';
}

/**
 * Resolve a project to its shards (one per workspace package). Returns an
 * empty array — signalling the caller to use the single-process build —
 * when the project isn't multi-package, when no worker script is
 * available to spawn, or when discovery fails. Each unit's file set is
 * enumerated via the graph adapter; partitions with no files are dropped.
 *
 * ADR-0032: reached for any run that did NOT pass `--exact` (see
 * {@link resolveEngineShards}) — sharded is the default. A project that yields
 * ≤1 non-empty shard falls back to the exact single-program engine naturally.
 */
async function resolveShards(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<ShardResolution> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) return { shards: [] };

  let units: readonly { id: string; rootDir: string; configPath?: string }[];
  try {
    units = await discoverPolyglotUnits(opts.cwd, resolveAdaptersForRun(opts, cli));
  } catch {
    /* v8 ignore next */
    return resolveSyntheticFlatShards(opts);
  }
  if (units.length <= 1) return resolveSyntheticFlatShards(opts);

  // Phase 1 (graph-sharded-exact-parity): enumerate the canonical file set ONCE
  // from project-wide root discovery — the SAME source + filter the exact engine
  // uses — then PARTITION it across the discovered unit boundaries. The old loop
  // re-derived each shard's files from that package's own tsconfig, which
  // excludes the package's __fixtures__ tree and (for some) its test files, so
  // the sharded engine silently dropped files the exact engine kept. Partitioning
  // the canonical set guarantees both engines see the identical files.
  const adapter = pickAdapter(opts.cwd);
  let rootDiscovery: ReturnType<typeof adapter.discoverFiles>;
  try {
    rootDiscovery = adapter.discoverFiles({ cwd: opts.cwd });
  } catch {
    /* v8 ignore next */
    return resolveSyntheticFlatShards(opts);
  }
  const canonicalFiles = resolveCanonicalFileSet(rootDiscovery.files);
  const shards = partitionFilesIntoShards({
    canonicalFiles,
    units: units.map((u) => ({
      id: u.id,
      rootDir: u.rootDir,
      ...(u.configPath === undefined ? {} : { configPathAbs: u.configPath }),
    })),
    projectRoot: rootDiscovery.projectDirAbs,
    rootConfigPathAbs: rootDiscovery.configPathAbs,
  });
  // Need at least two non-empty shards to justify the parallel/merge overhead.
  if (shards.length > 1) return { shards };
  return resolveSyntheticFlatShards(opts);
}

/**
 * Resolve a project's shard set the SAME way a production `graph` run does
 * (workspace units → canonical-file partition, else synthetic flat shards),
 * exposed for the real-repo equivalence guardrail (`graph-equivalence-check`).
 * Returns `[]` when the project isn't shardable (≤1 shard / no worker script) —
 * the guardrail rejects that, since the comparison is only meaningful on a
 * shardable multi-package repo. Reuses the private {@link resolveShards} so
 * there is ONE shard-resolution model, never a drifting copy.
 */
export async function resolveShardsForCwd(
  cwd: string,
  cliScript: string,
  cli: ToolCliContext,
): Promise<readonly Shard[]> {
  const resolution = await resolveShards({ cwd, cliScript, noCache: true }, cli);
  return resolution.shards;
}

/**
 * Flat-large fallback for single-tsconfig TypeScript repos. Workspace
 * sharding is preferred because package boundaries are semantically real. When
 * no workspace split exists and the TypeScript file count crosses the same
 * threshold as heap preflight's 12 GB tier, synthesize directory-coherent
 * shards and feed them into the existing sharded build.
 */
function resolveSyntheticFlatShards(opts: GraphCommandOptions): ShardResolution {
  if (typeof opts.language === 'string' && opts.language.length > 0) return { shards: [] };
  const adapter = pickAdapter(opts.cwd);
  if (adapter.id !== 'typescript') return { shards: [] };
  let discovery: ReturnType<typeof adapter.discoverFiles>;
  try {
    discovery = adapter.discoverFiles({ cwd: opts.cwd });
  } catch {
    return { shards: [] };
  }
  // Canonical set (Phase 1): drop fixtures before partitioning so the flat-large
  // fallback shards match the exact engine's file set just like the workspace path.
  const canonicalFiles = resolveCanonicalFileSet(discovery.files);
  // Measure the partition compute (layout detection + strategy resolution +
  // partitioning) where it runs — the profile run recorder does not exist yet
  // (its `mode` label needs the shard count), so executeGraph records the
  // timing afterwards via `recordStage` (ADR-0045 measurement plane).
  const partitionStart = Date.now();
  const layout = detectMonorepoLayout({
    repoRoot: discovery.projectDirAbs,
    files: canonicalFiles,
  });
  const selection = selectStrategyForLayout(layout);
  if (layout.kind !== 'flat-large' || selection.mode !== 'synthetic-partition') {
    return { shards: [] };
  }
  // Strategy precedence: `graph.partitionStrategy` (config/env, ADR-0045) >
  // the layout-recommended default > 'hybrid'. `loadGraphConfig` is
  // scope-first and cheap, so reading it here (off the hot path) is safe.
  const graphConfig = loadGraphConfig(opts.cwd);
  const strategy: PartitionStrategy =
    graphConfig.partitionStrategy ?? selection.partitionStrategy ?? 'hybrid';
  const partitions = partitionFlatRepo({
    files: layout.files,
    repoRoot: discovery.projectDirAbs,
    strategy,
  });
  const shards = partitions
    .filter((p) => p.files.length > 0)
    .map(
      (p): Shard => ({
        id: `partition:${p.id}`,
        rootDir: discovery.projectDirAbs,
        files: p.files,
        configPathAbs: discovery.configPathAbs,
      }),
    );
  if (shards.length <= 1) return { shards: [] };
  return {
    shards,
    partition: {
      durationMs: Date.now() - partitionStart,
      detail: `${strategy}: ${String(shards.length)} partition(s)`,
    },
  };
}

/**
 * The inputs the sharded build path threads from {@link executeGraph}: the
 * parsed options, the resolved shard set + its root, the CLI context, and
 * the run's config + recipe rules. Grouped so the build helpers stay under
 * the wide-function parameter budget and share one named shape.
 */
interface ShardedBuildContext {
  readonly opts: GraphCommandOptions;
  readonly shards: readonly Shard[];
  readonly projectRoot: string;
  readonly cli: ToolCliContext;
  readonly config: GraphConfig;
  readonly rules: readonly Rule[];
  /**
   * Optional progress callback (ADR-0032). The interactive live path threads the
   * Ink renderer's emitter here so the sharded build emits the SAME seven-stage
   * checklist the exact engine does. The static dispatch path leaves it
   * undefined (the `--profile` recorder hooks the per-build timing separately).
   */
  readonly onProgress?: GraphProgressCallback;
}

/** Drive the sharded build and adapt it to the RunGraphResult dispatch shape. */
async function runShardedBuild(ctx: ShardedBuildContext): Promise<RunGraphResult> {
  const { opts, shards, projectRoot, cli, config, rules } = ctx;
  const datastore = cli.scope.datastore() as DataStore | undefined;
  const sharded = await runShardedGraph({
    shards,
    projectRoot,
    cliScript: opts.cliScript ?? process.argv[1] ?? '',
    adapter: pickAdapter(projectRoot, opts.language),
    resolutionMode: opts.resolution ?? 'exact',
    concurrency: opts.concurrency,
    useCache: opts.noCache !== true,
    config,
    rules,
    catalogRepo: datastore ? new CatalogRepo(datastore) : null,
    emitFeatures: DASHBOARD_FEATURE_COLUMNS,
    ...(ctx.onProgress === undefined ? {} : { onProgress: ctx.onProgress }),
    ...(opts.language === undefined ? {} : { language: opts.language }),
  });
  return {
    catalog: sharded.catalog,
    indexes: sharded.indexes,
    signals: sharded.signals,
    resolutionStats: sharded.resolutionStats,
    cacheHit: sharded.cacheHit,
    features: sharded.features,
    shardStats: sharded.shardStats,
  };
}

async function runProfiledShardedBuild(
  profileRun: GraphProfileRunRecorder | undefined,
  ctx: ShardedBuildContext,
): Promise<RunGraphResult> {
  const started = Date.now();
  const result = await runShardedBuild(ctx);
  profileRun?.recordStage(
    'sharded-build',
    Date.now() - started,
    `${String(ctx.shards.length)} shard(s)`,
  );
  return result;
}

/**
 * The serializable live-build request the interactive runner (`graph-runner.tsx`)
 * hands the engine. Mirrors the subset of {@link GraphCommandOptions} the
 * whole-project live view exercises: cwd scope, cache/resolution tier, the
 * resolved rule subset + config, and `exact` (which, with the project's
 * shardability, selects the engine — ADR-0032). `cliScript` is needed to spawn
 * the shard subprocesses for the in-process sharded path.
 */
export interface GraphLiveBuildArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly resolution?: ResolutionMode;
  readonly exact?: boolean;
  readonly config?: GraphConfig;
  readonly rules?: readonly Rule[];
  readonly cliScript?: string;
}

/**
 * Resolve the build engine for the interactive live path — the SAME policy
 * `executeGraph` uses (ADR-0032): the SHARDED engine when `--exact` is absent
 * and the project yields >1 non-empty shard, the EXACT (single-program) engine
 * otherwise. Returns the shard set (`length > 1` ⇒ sharded) so the live runner
 * can decide its transport: sharded runs in-process (its shards are already
 * subprocesses), exact runs off-process in the `graph-run-worker` (ADR-0028).
 * `isTTY` is NEVER consulted — the engine is a pure function of the request +
 * shardability, identical to the static path.
 */
export async function resolveLiveEngineShards(
  args: GraphLiveBuildArgs,
  cli: ToolCliContext,
): Promise<Shard[]> {
  const opts: GraphCommandOptions = {
    cwd: args.cwd,
    noCache: args.noCache,
    resolution: args.resolution,
    exact: args.exact,
    ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
  };
  // No positional paths in the whole-project live view, so the engine decision
  // is `--exact` + shardability alone.
  const resolution = await resolveEngineShards(opts, cli, []);
  return resolution.shards;
}

/**
 * Run the SHARDED build in-process for the live view and reduce it to the slim,
 * serializable {@link LiveGraphOutput} the interactive runner consumes —
 * IDENTICAL in shape to what the off-process exact worker streams back, so both
 * live transports converge on one payload. The heavy per-shard parse/walk/resolve
 * runs in the shard SUBPROCESSES, so the main thread (which animates the Ink
 * checklist) is only orchestrating + merging — no off-process worker is needed
 * for the sharded path (ADR-0032). Progress events flow through `onProgress`,
 * mapped onto the same seven canonical stages the exact engine emits.
 *
 * Crosses the single suppression chokepoint via {@link buildLiveGraphOutput}
 * (against `args.cwd`, the build root) — so the live sharded path waives
 * `@graph-ignore` directives IDENTICALLY to the static/exact paths (ADR-0014/0031).
 */
export async function runShardedLiveBuild(
  args: GraphLiveBuildArgs,
  shards: readonly Shard[],
  datastore: DataStore | undefined,
  onProgress: GraphProgressCallback,
): Promise<LiveGraphOutput> {
  const result = await runShardedGraph({
    shards,
    projectRoot: args.cwd,
    cliScript: args.cliScript ?? process.argv[1] ?? '',
    adapter: pickAdapter(args.cwd),
    resolutionMode: args.resolution ?? 'exact',
    useCache: args.noCache !== true,
    config: args.config ?? {},
    // The live dispatch always resolves the recipe → rules; fall back to the
    // full registered set if a programmatic caller omits them (parity with the
    // exact path, where `runGraph` applies the same `?? currentRules()` default).
    rules: args.rules ?? currentRules(),
    catalogRepo: datastore ? new CatalogRepo(datastore) : null,
    emitFeatures: DASHBOARD_FEATURE_COLUMNS,
    onProgress,
  });
  return buildLiveGraphOutput(
    {
      catalog: result.catalog,
      indexes: result.indexes,
      signals: result.signals,
      cacheHit: result.cacheHit,
    },
    args.cwd,
  );
}

/** Profile bucket for the run shape: workspace fan-out, multi-path, or single graph. */
function profileMode(opts: GraphCommandOptions): string {
  if (opts.workspace === true) return 'workspace';
  if ((opts.paths?.length ?? 0) > 1) return 'multi-path';
  return 'graph';
}

function createProfileBuilder(
  opts: GraphCommandOptions,
  startedAt: string,
): GraphProfileBuilder | undefined {
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) {
    return undefined;
  }
  return new GraphProfileBuilder({
    cwd: opts.cwd,
    mode: profileMode(opts),
    resolutionMode: opts.resolution,
    startedAt,
  });
}

function writeProfileIfRequested(
  opts: GraphCommandOptions,
  profile: GraphProfileBuilder | undefined,
): void {
  if (profile === undefined) return;
  if (typeof opts.profileOutput !== 'string' || opts.profileOutput.length === 0) return;
  const outPath = writeGraphProfile(opts.profileOutput, opts.cwd, profile.complete());
  logger.info({
    evt: 'graph.profile.write.complete',
    module: MODULE_GRAPH_CLI,
    output: outPath,
  });
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
  if (opts.workspace === true && (opts.gateSave === true || opts.gateCompare === true)) {
    throw new ConfigurationError(
      '--workspace and --gate-save/--gate-compare are mutually exclusive. ' +
        'Gates and baselines apply to production code; --workspace intentionally scans the full project (including dependencies and test fixtures).',
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

/**
 * The ambient run context {@link executeGraph} threads into the multi-path
 * fan-out: parsed options, CLI context, recipe rules, the run's start
 * timestamp, and the optional profile builder. Grouped to keep the helper
 * under the wide-function parameter budget.
 */
interface MultiPathContext {
  readonly opts: GraphCommandOptions;
  readonly cli: ToolCliContext;
  readonly rules: readonly Rule[];
  readonly startedAt: string;
  readonly profile?: GraphProfileBuilder;
}

async function executeMultiPathGraph(
  ctx: MultiPathContext,
  paths: readonly string[],
): Promise<GraphRunOutcome | undefined> {
  const { opts, cli, rules, startedAt, profile } = ctx;
  const allSignals: Signal[] = [];
  let combinedFiles = 0;
  let totalSuppressed = 0;
  let lastResult: Awaited<ReturnType<typeof runGraph>> | null = null;
  const config = loadGraphConfig(opts.cwd);
  for (const p of paths) {
    const profileRun = profile?.startRun({
      label: positionalPathLabel(p, opts.cwd),
      cwd: p,
      mode: 'single-process',
    });
    const r = await runGraph({
      cwd: p,
      noCache: opts.noCache,
      resolution: opts.resolution,
      language: opts.language,
      config,
      rules,
      datastore: cli.scope.datastore() as DataStore | undefined,
      emitFeatures: DASHBOARD_FEATURE_COLUMNS,
      onProgress: profileRun?.onProgress,
    });
    profileRun?.finish(r);
    lastResult = r;
    // Each path's signals are relative to THAT path's root — so waive them
    // against `p` here, before aggregating. A single post-aggregation pass
    // (the old shape) could only use one base and would leak waivers for every
    // path but one. Each per-path call crosses the single suppression
    // chokepoint (finalizeGraphSignals); the aggregate is then re-branded once
    // below via assertFinalizedAcrossBoundary (an assertion that every member
    // was finalized, NOT a second suppression pass).
    const finalized = await finalizeGraphSignals(r.signals, p);
    totalSuppressed += finalized.suppressedCount;
    allSignals.push(...finalized.signals);
    if (r.catalog !== null) combinedFiles += countFiles(r.catalog);
  }
  // D14: count files across every analyzed path. Zero files + a
  // `--language` override → exit 2 with the canonical message.
  if (typeof opts.language === 'string' && opts.language.length > 0 && combinedFiles === 0) {
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
  // `allSignals` is already waived per-path (each against its own root), so
  // deliver directly — a second suppression pass would have no single correct
  // root and risk re-resolving paths under the wrong base. Re-brand the
  // aggregate FinalizedSignals (each member already crossed finalizeGraphSignals
  // above) so deliverGraphResult's persist call gets the type it requires.
  const finalizedAggregate = assertFinalizedAcrossBoundary(allSignals, totalSuppressed);
  return await deliverGraphResult(opts, combined, cli, startedAt, finalizedAggregate);
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
// Returns the run's {@link GraphRunOutcome} for every mode that should deliver
// signals (gate, catalog, `--report-to`, default render) so the composition
// root can cloud-emit + report-to it ONCE (ADR-0011 / ADR-0008) and the host
// can persist the optional session contribution (host-owned-run-timing Phase
// 3). Returns `undefined` for plain `--json` (the `--workspace` child carrier —
// children must not each emit cloud signals).
export async function dispatchGraphResult(
  opts: GraphCommandOptions,
  rawResult: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
  startedAt: string,
  suppressionRoot: string,
): Promise<GraphRunOutcome | undefined> {
  // ADR-0014: apply the inline graph-ignore waivers BEFORE any mode consumes
  // the signals — the gate baseline, catalog, render, and session persistence
  // all see the post-waiver set. `--workspace` is covered transitively: each
  // child runs `graph --json` through this function, so the parent aggregates
  // already-waived signals.
  //
  // `suppressionRoot` is the build root the signals' `code.file` paths are
  // RELATIVE TO — i.e. the positional subtree / sharded-child / workspace-unit
  // root, NOT necessarily `opts.cwd`. A `graph <subdir>` run (and every
  // `--workspace` child, which runs `graph <unitRoot> --json`) builds against
  // `runCwd = positionalPaths[0]`, so its signal paths and directive files
  // resolve under that root. Resolving against `opts.cwd` instead made every
  // `@graph-ignore` directive file unreadable (ENOENT), silently leaking the
  // waiver — the bug this parameter closes.
  // Route through the SINGLE suppression chokepoint (finalizeGraphSignals) — the
  // same seam the live/worker producers cross via buildLiveGraphOutput. The
  // branded FinalizedSignals it returns is the only signal shape the
  // session-contribution builder (and, transitively, the verdict + render) will
  // accept, so a future fourth output path cannot deliver un-waived signals: the
  // compiler rejects it.
  const finalized = await finalizeGraphSignals(rawResult.signals, suppressionRoot);
  return deliverGraphResult(
    opts,
    { ...rawResult, signals: finalized.signals },
    cli,
    startedAt,
    finalized,
  );
}

/**
 * Deliver an already-waived run to its output mode (gate / catalog-json /
 * render) and, on the human-facing render path, BUILD the generic-session
 * contribution the host run plane persists (host-owned-run-timing Phase 3 —
 * graph never writes the row itself). Split out of {@link dispatchGraphResult}
 * so the multi-path path — which must waive each path's signals against ITS
 * OWN root before aggregating (the roots differ) — can aggregate the kept
 * signals and deliver once, without a second (wrong-root) suppression pass.
 *
 * The contribution is built HERE, where the branded {@link FinalizedSignals}
 * is in scope, so the dashboard history can only ever carry post-waiver
 * findings (the branding guard is not lost across the return boundary).
 */
async function deliverGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
  startedAt: string,
  finalized: FinalizedSignals,
): Promise<GraphRunOutcome | undefined> {
  const suppressedCount = finalized.suppressedCount;
  const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
  if (opts.gateSave === true || opts.gateCompare === true) {
    // ADR-0036: the envelope arrives fingerprint-stamped — `buildGraphEnvelope`
    // passes graph's byte-preserved strategy into `buildSignalEnvelope`, which
    // stamps at construction (over the canonical remapped ruleIds, exactly what
    // the former post-hoc gate-path stamp produced). The host seams only read
    // `signal.fingerprint`. runGateMode owns the deliverSignals call
    // (host-derived exit), so the command-spec skips it.
    const envelope = envelopeFor(opts, result, durationMs);
    await runGateMode(opts, envelope, cli, result.catalog?.resolutionMode);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI, suppressed: suppressedCount });
    return { envelope };
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    runCatalogJsonMode(opts, result, cli, startedAt);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI, suppressed: suppressedCount });
    return { envelope: envelopeFor(opts, result, durationMs) };
  }
  const envelope = await renderGraphResult(opts, result, startedAt, cli);
  // Session persistence is dashboard history — populated on human-facing runs
  // only. Skipped for:
  //   - `--json` (the machine-artifact mode AND the carrier each
  //     `executeWorkspaceGraph` child runs under — keeps "one human invocation
  //     = one session"; the --workspace parent persists the single aggregate);
  //   - `--report-to` (an export mode; like gate/catalog it opts out of session
  //     history — the root delivers the envelope to the receiver instead).
  // The host persists the returned `session` after the handler resolves; graph
  // builds it here from the BRANDED FinalizedSignals so the contribution can
  // only ever carry post-waiver findings regardless of which path reached here.
  const isReportTo = typeof opts.reportTo === 'string' && opts.reportTo.length > 0;
  const session =
    opts.json !== true && !isReportTo ? buildGraphSessionContribution(opts, finalized) : undefined;
  cli.setExitCode(EXIT_CODES.SUCCESS);
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
    suppressed: suppressedCount,
  });
  // Plain `--json` is the workspace-child carrier: it returns `undefined` so
  // the root does not cloud-emit per child (the parent owns the dashboard
  // aggregate, not per-unit signal batches — audit P1-2). Every other mode
  // (default render, `--report-to`) returns the outcome for root delivery; only
  // the non-export render path carries a `session`.
  return opts.json === true ? undefined : { envelope, ...(session ? { session } : {}) };
}

/**
 * Render the run and return its {@link SignalEnvelope} (ADR-0011).
 *
 * `--json` emits the envelope through the shared `formatSignalJson`
 * (`cli.emitEnvelope`). The default/`--verbose` path hands a `graph-done`
 * result to the render seam (Ink on TTY, plain text in pipes/CI): graph's
 * report is richer than the neutral per-unit table — it carries the verbose
 * catalog/findings/entry-point body as `verboseDetail` ({kind:'lines'},
 * ADR-0021), a fast-tier caveat (`resolutionBanner`), and the one-line
 * PASS/FAIL `summary`; the non-verbose footer hints are emitted by the shared
 * seam (`graphDoneView`). The summary counts are derived from the envelope's
 * verdict so `--json` and the human report agree; the envelope itself is NOT
 * carried on the result (it would route to the neutral unit table and drop
 * graph's body), but IS returned for the composition root's cloud +
 * `--report-to` delivery.
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
  // ADR-0021: graph's verbose body is carried as VerboseDetail{kind:'lines'} and
  // rendered through the shared resultToView seam — the same path the live runner
  // uses — instead of a graph-only `reportLines`/`footerHints` shape. The
  // non-verbose footer hints are emitted by the seam (`graphDoneView`).
  const verboseDetail: VerboseDetail | undefined = verbose
    ? {
        kind: 'lines',
        lines: buildUnifiedReportLines(
          {
            catalog: result.catalog,
            indexes: result.indexes,
            signals: result.signals,
            cacheHit: result.cacheHit,
          },
          { includeSummary: false },
        ),
      }
    : undefined;
  const resolutionBanner = resolutionBannerText(result.catalog?.resolutionMode);
  const { summary } = envelope.verdict;
  const done: GraphDoneResult = {
    type: 'graph-done',
    ...(verboseDetail === undefined ? {} : { verboseDetail }),
    ...(resolutionBanner === undefined ? {} : { resolutionBanner }),
    summary: {
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      warnings: summary.warnings,
    },
    durationMs,
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
  profile?: GraphProfileBuilder,
): Promise<GraphRunOutcome | undefined> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--workspace: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const adapters = resolveAdaptersForRun(opts, cli);
  const units = await discoverPolyglotUnits(opts.cwd, adapters);
  if (units.length === 0) {
    const adapterLabel = adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip graph' for whole-project analysis.`,
    );
  }

  const profileRun = profile?.startRun({ label: 'workspace', cwd: opts.cwd, mode: 'workspace' });
  // Internal per-run timer for the workspace REPORT artifact (durationMs in the
  // JSON document / report header + the profile stage). NOT a session timestamp:
  // the generic session row's timing is host-owned (host-owned-run-timing Phase
  // 3), stamped from the host RunTimer after this handler returns.
  const startedAt = Date.now();
  const result = await runWorkspaceUnitsInParallel({
    cwd: opts.cwd,
    units,
    cliScript,
    concurrency: opts.concurrency,
    noCache: opts.noCache,
    resolution: opts.resolution,
    recipe: opts.recipe,
    ...(opts.language === undefined ? {} : { language: opts.language }),
  });
  const durationMs = Date.now() - startedAt;
  profileRun?.recordStage('workspace-fanout', durationMs, `${String(units.length)} unit(s)`);

  const allSignals: Signal[] = [];
  for (const r of result.perUnit) allSignals.push(...r.signals);
  profileRun?.finishSummary({
    cacheHit: false,
    signals: allSignals.length,
  });

  // Build exactly one aggregate session contribution for the whole --workspace
  // invocation (non-json path only). Matches the contract "one human-facing CLI
  // invocation = one session" that fitness/sim already follow; the per-unit child
  // processes don't contribute because they always run with --json (see
  // dispatchGraphResult). The host run plane persists the returned `session`
  // after this handler resolves — graph never writes the row itself
  // (host-owned-run-timing Phase 3).
  //
  // Cloud signal sync (ADR-0008) is intentionally NOT emitted for --workspace
  // (audit P1-2): the parent aggregates per-unit signals for the dashboard, not
  // for the cloud, and the --json children skip emit to avoid fragmented
  // per-unit batches. So the returned outcome carries a `session` but NO
  // envelope. A whole-project `graph` run emits normally (the root's
  // deliverSignals on the returned envelope).
  let session: ToolSessionContribution | undefined;
  if (opts.json === true) {
    // ADR-0011: emit through the CLI seam, not process.stdout directly.
    // cli.emitJson applies the same JSON.stringify(_, null, 2) + '\n'.
    cli.emitJson(buildWorkspaceJsonDocument(result.perUnit, durationMs));
  } else {
    await writeWorkspaceReport(result.perUnit, durationMs, cli);
    session = buildWorkspaceSessionContribution(opts, allSignals);
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
  // The aggregate outcome carries the single session (non-json path) but NO
  // envelope — the parent does not cloud-emit per-unit signals (audit P1-2).
  // `undefined` on the --json carrier path keeps the host from persisting.
  return session === undefined ? undefined : { session };
}

/**
 * Build the generic-session contribution for a single-process graph run from
 * the branded {@link FinalizedSignals} (host-owned-run-timing Phase 3). The
 * host run plane stamps timing + id and persists the row after the handler
 * returns — graph never writes the generic `StoredSession` itself.
 *
 * Takes the branded {@link FinalizedSignals} (not a raw `Signal[]`): the only
 * way to obtain one is to cross the single suppression chokepoint
 * (`finalizeGraphSignals`, or `assertFinalizedAcrossBoundary` after the worker
 * IPC boundary). This is the compile-time guardrail that makes the TTY-leak bug
 * un-regressable — a caller that hands raw, un-waived signals here does not
 * type-check, so the dashboard history can never record un-waived findings.
 *
 * The single-process path holds the raw engine signals (engine slugs), so the
 * session payload's per-rule keys are engine slugs directly.
 */
function buildGraphSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  finalized: FinalizedSignals,
): ToolSessionContribution {
  return contributionFromSignals(opts, finalized.signals);
}

/**
 * Build the aggregate generic-session contribution for a `--workspace` run.
 *
 * Child envelopes carry Option-A-mapped OpenSIP rule IDs; reverse-map back to
 * engine slugs so the aggregate session payload's per-rule metric columns
 * (keyed on engine slugs in the dashboard) keep working — exactly what the old
 * `persistWorkspaceSession` did before handing off to the shared save.
 */
function buildWorkspaceSessionContribution(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
): ToolSessionContribution {
  const engineSignals = signals.map((s) => {
    const ruleId = mapOpenSipRuleIdToEngineSlug(s.ruleId);
    return { ...s, ruleId, source: ruleId };
  });
  return contributionFromSignals(opts, engineSignals);
}

/**
 * Shared contribution builder: derive graph's opaque session payload + the
 * generic verdict (`score`/`passed`) from a run's engine-slug `Signal[]`. The
 * payload is graph-owned detail (summary + rule-grouped per-signal findings);
 * the generic session row holds zero graph vocabulary. `score`/`passed` mirror
 * exactly what the former `saveGraphSession` computed (pass rate over
 * passed/total rules; `passed` ⇔ no error-severity signals).
 */
function contributionFromSignals(
  opts: Pick<GraphCommandOptions, 'cwd' | 'recipe'>,
  signals: readonly Signal[],
): ToolSessionContribution {
  const payload = buildGraphSessionPayload(signals);
  return {
    tool: 'graph',
    cwd: opts.cwd,
    ...(opts.recipe === undefined ? {} : { recipe: opts.recipe }),
    score: passRate(payload.summary),
    passed: payload.summary.errors === 0,
    payload,
  };
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

export { buildUnifiedReportLines, buildLiveGraphOutput } from './graph-report.js';
