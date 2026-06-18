// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `graph-baseline-export` writes the JSON baseline to a file and prints a one-line "Exported graph baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
// @fitness-ignore-file detached-promises -- async command handlers invoke synchronous helpers (runCatalogJsonMode/runSarifExportMode/handleGraphError all return void); the heuristic flags them inside the async handlers. Matches the sibling graph CLI files (graph.ts, graph-modes.ts, orchestrate.ts).
// @fitness-ignore-file only-documented-toolcli-seams -- same rationale as the no-direct-stdout waiver above: the one-line "Exported graph baseline to <path>" status confirmation after a file write; the --json path uses cli.emitJson. Not run output through a ToolCliContext seam.
/**
 * graph-aux-command-specs — the declarative graph auxiliary commands (release
 * launch Phase 5 Task 5.2).
 *
 * Replaces graph's hand-rolled `registerGraph*Command()` bodies. The host mounts
 * each spec via `mountCommandSpec`; the tool no longer touches Commander. Each
 * helper's raw `.option()`/`.argument()` calls translate 1:1 to
 * `OptionSpec`/`ArgSpec`; positional arguments arrive on the parsed-opts object
 * under the `_args` key (the host's uniform positional convention — see
 * `mountCommandSpec`).
 *
 * Output modes:
 *  - `graph-recipes` → `command-result`: the handler returns the list result;
 *    the host dispatches it through the shared seam (`--json` → JSON, else
 *    render). Byte-identical to the former `if (json) emitJson else render` body.
 *  - every other aux command → `raw-stream`: each owns its full IO (writes a
 *    file and/or prints a line, sets its own exit code, owns its `--json`
 *    branch) — the documented non-Ink exception. The host renders nothing.
 */

import { commonFlags, EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, defineCommand, logger } from '@opensip-cli/core';

import { executeEquivalenceCheck } from '../equivalence-check-command.js';
import { runCatalogJsonMode } from '../graph-modes.js';
import { listGraphRecipes } from '../graph-recipes.js';
import { handleGraphError } from '../graph.js';
import { executeLookup } from '../lookup.js';
import { runGraph } from '../orchestrate.js';
import { runSarifExportMode } from '../sarif-export.js';
import { executeShardWorker } from '../shard-worker.js';
import { executeSymbolIndex } from '../symbol-index.js';

import type { ResolutionMode } from '../../types.js';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

// Shared --cwd flag string for the auxiliary subcommands that declare it as a
// tool option (symbol-index keeps a custom description; the export commands keep
// the canonical one). Sourced from the ADR-0021 common-flag registry so the
// string matches the run command's --cwd and cannot drift.
const OPT_CWD = commonFlags.cwd.flags;
const OPT_DESC_CWD = commonFlags.cwd.description;

// Shared output mode for the file-/stdout-writing aux commands (every aux
// command except graph-recipes owns its full IO). Extracted to a const so the
// literal is declared once (sonarjs/no-duplicate-string) and stays a typed
// CommandOutputMode member.
const RAW_STREAM = 'raw-stream' as const;

/** Read the single trailing positional (`<name>` / `<specPath>`) off the parsed opts. */
function firstArg(opts: Record<string, unknown>): string {
  const args = (opts._args ?? []) as readonly string[];
  return args[0] ?? '';
}

// =============================================================================
// SHARED EXPORT OPTION SPECS (tool-command-surface-taxonomy Task 2.1)
//
// The canonical `graph export --format <fmt>` command and the three legacy
// flat-root export commands (`sarif-export` / `catalog-export` /
// `graph-baseline-export`) must declare BYTE-IDENTICAL option help/choices. To
// guarantee that, every export OptionSpec is declared exactly once here and
// reused by both the canonical spec (where it is OPTIONAL — the per-format
// required subset is validated at runtime) and each legacy spec (where it keeps
// its original `required` declaration). Reusing the SAME object also keeps the
// behaviour-parity snapshot byte-stable across the canonical/legacy mounts.
// =============================================================================

/** `--out` for the baseline (graph-baseline-export) export — JSON fingerprints. */
const OPT_BASELINE_OUT = {
  flag: '--out',
  value: '<path>',
  description: 'Output file path for the JSON baseline',
} as const;

/** `--catalog-output` (catalog-export). */
const OPT_CATALOG_OUTPUT = {
  flag: '--catalog-output',
  value: '<path>',
  description: 'Output file path for the CatalogExport JSON',
} as const;

/** `--output-sarif` (sarif-export). */
const OPT_OUTPUT_SARIF = {
  flag: '--output-sarif',
  value: '<path>',
  description: 'Output file path for the SARIF v2.1.0 document',
} as const;

/** `--tenant-id` (catalog/sarif export). */
const OPT_TENANT_ID_CATALOG = {
  flag: '--tenant-id',
  value: '<id>',
  description: 'Tenant scope stamped on every row + provenance',
} as const;
const OPT_TENANT_ID_SARIF = {
  flag: '--tenant-id',
  value: '<id>',
  description: 'Tenant scope for the run',
} as const;

/** `--repo-id` (catalog/sarif export). */
const OPT_REPO_ID_CATALOG = {
  flag: '--repo-id',
  value: '<id>',
  description: 'Repository scope stamped on every row',
} as const;
const OPT_REPO_ID_SARIF = {
  flag: '--repo-id',
  value: '<id>',
  description: 'Repository scope for the run',
} as const;

/** `--git-sha` (catalog-export). */
const OPT_GIT_SHA = {
  flag: '--git-sha',
  value: '<sha>',
  description: 'Commit SHA the catalog was extracted at',
} as const;

/** `--run-id` (catalog/sarif export). */
const OPT_RUN_ID_CATALOG = {
  flag: '--run-id',
  value: '<uuid>',
  description: 'Run id for provenance (auto-generated if absent)',
} as const;
const OPT_RUN_ID_SARIF = {
  flag: '--run-id',
  value: '<uuid>',
  description: 'Run id for trace correlation (auto-generated if absent)',
} as const;

/** `--mode` (catalog-export). */
const OPT_MODE = {
  flag: '--mode',
  value: '<mode>',
  description: "'initial' (full rebuild) or 'incremental' (reuse cache when present)",
  default: 'initial',
} as const;

/** `--changed-file` (catalog-export) — repeatable accumulator. */
const OPT_CHANGED_FILE = {
  flag: '--changed-file',
  value: '<relPath>',
  description:
    'Changed file (repeatable). Advisory today — the engine derives the true changed set from fingerprint diffs; recorded for observability.',
  arrayDefault: [] as readonly string[],
  parse: (val: string, prev: unknown) => [...(prev as string[]), val],
} as const;

/** `--cwd` (catalog/sarif export) — the canonical common-flag description. */
const OPT_CWD_EXPORT = { flag: OPT_CWD, description: OPT_DESC_CWD, default: process.cwd() } as const;

/** `--language` (catalog/sarif export). */
const OPT_LANGUAGE = {
  flag: '--language',
  value: '<name>',
  description: 'Force a specific language adapter (suppresses auto-detection)',
} as const;

/** `--resolution` (catalog/sarif export) — host-validated choices enum. */
const OPT_RESOLUTION = {
  flag: '--resolution',
  value: '<mode>',
  description: 'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
  default: 'exact',
  choices: ['exact', 'fast'] as readonly string[],
} as const;

// =============================================================================
// SHARED EXPORT HANDLER BODIES (tool-command-surface-taxonomy Task 2.1)
//
// Extract-method only — the legacy specs and the canonical `graph export` spec
// call the SAME body, so behaviour (and the `EngineSubprocessPort` consumer
// contracts, DEC-498) is unchanged. The canonical spec validates the
// per-format required flag subset BEFORE delegating here; the legacy specs rely
// on Commander's `required` declaration.
// =============================================================================

interface GraphSarifExportOpts {
  outputSarif: string;
  tenantId: string;
  repoId: string;
  runId?: string;
  cwd: string;
  language?: string;
  resolution?: string;
}

/** Run graph analysis and write OpenSIP-convention SARIF to `--output-sarif`. */
async function runGraphSarifExport(opts: GraphSarifExportOpts, cli: ToolCliContext): Promise<void> {
  try {
    const resolution: ResolutionMode = opts.resolution === 'fast' ? 'fast' : 'exact';
    const result = await runGraph({
      cwd: opts.cwd,
      noCache: true,
      resolution,
      language: opts.language,
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    await runSarifExportMode(
      {
        outputSarif: opts.outputSarif,
        tenantId: opts.tenantId,
        repoId: opts.repoId,
        runId: opts.runId,
      },
      result.signals,
      cli,
    );
  } catch (error) {
    handleGraphError('sarif-export', error, cli);
  }
}

interface GraphCatalogExportOpts {
  catalogOutput: string;
  tenantId: string;
  repoId: string;
  gitSha: string;
  runId?: string;
  mode?: string;
  changedFile?: readonly string[];
  cwd: string;
  language?: string;
  resolution?: string;
}

/** Run graph analysis and write the CatalogExport JSON to `--catalog-output`. */
async function runGraphCatalogExport(
  opts: GraphCatalogExportOpts,
  cli: ToolCliContext,
): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    // `--resolution`'s value is `exact`/`fast` by construction (declared
    // `choices`); the mount layer rejected any other value before we got here.
    const resolution: ResolutionMode = opts.resolution === 'fast' ? 'fast' : 'exact';
    const incremental = opts.mode === 'incremental';
    const changedFiles = opts.changedFile ?? [];
    if (incremental && changedFiles.length > 0) {
      // Advisory only: the incremental path self-derives the changed set from
      // on-disk fingerprint diffs, so a caller-supplied set does not (yet)
      // narrow the walk. Logged for observability.
      logger.info({
        evt: 'graph.cli.catalog_export.changed_files_advisory',
        module: 'graph:cli',
        runId: opts.runId,
        changedFileCount: changedFiles.length,
      });
    }
    const result = await runGraph({
      cwd: opts.cwd,
      noCache: !incremental,
      resolution,
      language: opts.language,
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    runCatalogJsonMode(
      {
        cwd: opts.cwd,
        catalogOutput: opts.catalogOutput,
        tenantId: opts.tenantId,
        repoId: opts.repoId,
        gitSha: opts.gitSha,
        runId: opts.runId,
      },
      result,
      cli,
      startedAt,
    );
  } catch (error) {
    handleGraphError('catalog-export', error, cli);
  }
}

/**
 * Export the graph gate fingerprint baseline (JSON) to `--out` via the host
 * baseline seam (ADR-0036). Maps the ConfigurationError "no baseline" path to
 * exit 2 for both the `--json` and plain-text boundaries.
 */
async function runGraphBaselineExport(
  opts: { cwd: string; out: string; json?: boolean },
  cli: ToolCliContext,
): Promise<void> {
  try {
    await cli.exportBaselineFingerprints('graph', opts.out);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      error instanceof ConfigurationError
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR;
    logger.warn({
      evt: 'cli.graph.baseline_export.failed',
      module: 'graph:cli',
      message,
      exitCode,
    });
    if (opts.json === true) {
      cli.emitError({ message, exitCode });
      return;
    }
    cli.setExitCode(exitCode);
    process.stderr.write(`Error: ${message}\n`);
    return;
  }
  const result = { type: 'graph-baseline-export' as const, outPath: opts.out };
  if (opts.json === true) {
    cli.emitJson(result);
    return;
  }
  process.stdout.write(`Exported graph baseline to ${opts.out}\n`);
}

/** The legacy-alias telemetry event name (Task 2.3) — one event so a single
 *  query counts deprecated-export usage across all four legacy commands. */
const LEGACY_ALIAS_EVENT = 'cli.command.legacy_alias_used';

/** `graph-lookup` — look up function occurrences by simple name. */
export const graphLookupCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-lookup',
  description: 'Look up function occurrences by simple name from the persisted catalog',
  commonFlags: ['json'],
  args: [{ name: 'name', description: 'Function simple name to look up (e.g. "saveBaseline")' }],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'lookup',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as { json?: boolean } & Record<string, unknown>;
    await executeLookup({ name: firstArg(opts), json: opts.json }, cli);
  },
});

/** `graph-shard-worker` — [internal] build one shard from a spec file. */
export const graphShardWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-shard-worker',
  description:
    '[internal] Build one shard from a spec file and emit a ShardBuildResult JSON (spawned by the sharded build)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON ShardWorkerSpec file' }],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts, cli): Promise<void> => {
    await executeShardWorker(firstArg(rawOpts as Record<string, unknown>), cli);
  },
});

/**
 * `graph-equivalence-check` — [internal] REAL-REPO sharded≡exact equivalence
 * guardrail. Builds both catalogs on the target with the real adapter (real
 * `dist/*.d.ts` resolution), classifies the residual by owner file, and gates
 * the PRODUCTION divergence against the committed budget. The dogfood/CI gate
 * the synthetic in-test harness cannot be (it agrees by construction). Owns its
 * full IO + exit code (raw-stream).
 */
export const graphEquivalenceCheckCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-equivalence-check',
  description:
    '[internal] Verify the sharded build is byte-equivalent to the exact build on a real repo (gates production edge divergence against a committed budget)',
  commonFlags: [],
  options: [
    {
      flag: OPT_CWD,
      description: 'Target repo root to check (default: current directory)',
      default: process.cwd(),
    },
    {
      flag: '--budget',
      value: '<path>',
      description: 'Path to the committed budget JSON (relative to cwd or absolute)',
      default: '.config/graph-equivalence-budget.json',
    },
    {
      flag: '--update-budget',
      description:
        'Rewrite the budget file to the observed production divergence count (capture/tighten); always exits 0',
    },
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'diagnostic-gate',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as { cwd: string; budget?: string; updateBudget?: boolean };
    await executeEquivalenceCheck(
      { cwd: opts.cwd, budget: opts.budget, updateBudget: opts.updateBudget },
      cli,
    );
  },
});

/** `graph-symbol-index` — emit a symbolindex.json artifact. */
export const graphSymbolIndexCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-symbol-index',
  description:
    'Emit a symbolindex.json artifact (name→file:line and file→names) from the persisted catalog',
  commonFlags: [],
  options: [
    // --cwd keeps its command-specific description (the out path resolves
    // against it), so it is declared as a tool option rather than the common
    // flag. The literal default is `process.cwd()`, evaluated once at module
    // load (CLI startup) — equivalent to the former register-time evaluation.
    {
      flag: OPT_CWD,
      description: 'Target directory (out path resolves against this)',
      default: process.cwd(),
    },
    {
      flag: '--out',
      value: '<path>',
      description: 'Output file path',
      default: 'symbolindex.json',
    },
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'file-export',
  handler: (rawOpts, cli): void => {
    const opts = rawOpts as { cwd: string; out: string };
    executeSymbolIndex({ cwd: opts.cwd, out: opts.out }, cli);
  },
});

/** `graph-baseline-export` — export the graph gate baseline (JSON). */
export const graphBaselineExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-baseline-export',
  description: 'Export the graph gate baseline (JSON) from the datastore to a file',
  commonFlags: ['cwd', 'json'],
  // Legacy alias of `graph export --format baseline`: keeps `--out` REQUIRED
  // (its consumer/script contract) while delegating to the shared body.
  options: [{ ...OPT_BASELINE_OUT, required: true }],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as { cwd: string; out: string; json?: boolean };
    // Task 2.3: deprecated-command telemetry (canonical form: `graph export
    // --format baseline`). Side log only — no behaviour/exit-code change.
    logger.info({
      evt: LEGACY_ALIAS_EVENT,
      module: 'graph:cli',
      legacyCommand: 'graph-baseline-export',
      canonical: 'graph export --format baseline',
    });
    await runGraphBaselineExport(opts, cli);
  },
});

/**
 * `catalog-export` — dedicated subcommand carrying the catalog-JSON renderer +
 * machine flags (`--catalog-output`/`--tenant-id`/`--repo-id`/`--git-sha`). This
 * is the CLI contract the opensip `EngineSubprocessPort.runCatalogExport` spawns
 * (DEC-498). The flags live here, NOT on `graph` — the v1 `graph
 * --catalog-output` shape was retired by the split, so docs/consumers must
 * target `catalog-export`.
 */
export const graphCatalogExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'catalog-export',
  description:
    'Run graph analysis and write the CatalogExport JSON document (symbols + edges + provenance) to a file',
  commonFlags: [],
  // Legacy alias of `graph export --format catalog`: keeps its four REQUIRED
  // flags (the DEC-498 EngineSubprocessPort.runCatalogExport contract) while
  // sharing the option objects + handler body with the canonical spec.
  options: [
    { ...OPT_CATALOG_OUTPUT, required: true },
    { ...OPT_TENANT_ID_CATALOG, required: true },
    { ...OPT_REPO_ID_CATALOG, required: true },
    { ...OPT_GIT_SHA, required: true },
    OPT_RUN_ID_CATALOG,
    OPT_MODE,
    OPT_CHANGED_FILE,
    OPT_CWD_EXPORT,
    OPT_LANGUAGE,
    OPT_RESOLUTION,
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as GraphCatalogExportOpts;
    // Task 2.3: deprecated-command telemetry (canonical: `graph export
    // --format catalog`). The DEC-498 consumer port still spawns this name.
    logger.info({
      evt: LEGACY_ALIAS_EVENT,
      module: 'graph:cli',
      legacyCommand: 'catalog-export',
      canonical: 'graph export --format catalog',
    });
    await runGraphCatalogExport(opts, cli);
  },
});

/**
 * `sarif-export` — runs the pipeline and writes OpenSIP-convention SARIF to a
 * file, matching the opensip `EngineSubprocessPort.runSarifExport` contract
 * (DEC-498). Always a full run (findings, not incremental).
 */
export const graphSarifExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'sarif-export',
  description: 'Run graph analysis and write OpenSIP-convention SARIF v2.1.0 findings to a file',
  commonFlags: [],
  // Legacy alias of `graph export --format sarif`: keeps its three REQUIRED
  // flags (the DEC-498 EngineSubprocessPort.runSarifExport contract) while
  // sharing the option objects + handler body with the canonical spec.
  options: [
    { ...OPT_OUTPUT_SARIF, required: true },
    { ...OPT_TENANT_ID_SARIF, required: true },
    { ...OPT_REPO_ID_SARIF, required: true },
    OPT_RUN_ID_SARIF,
    OPT_CWD_EXPORT,
    OPT_LANGUAGE,
    OPT_RESOLUTION,
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as GraphSarifExportOpts;
    // Task 2.3: deprecated-command telemetry (canonical: `graph export
    // --format sarif`). The DEC-498 consumer port still spawns this name.
    logger.info({
      evt: LEGACY_ALIAS_EVENT,
      module: 'graph:cli',
      legacyCommand: 'sarif-export',
      canonical: 'graph export --format sarif',
    });
    await runGraphSarifExport(opts, cli);
  },
});

/**
 * The canonical graph export formats (taxonomy spec Q2: one `export` subcommand
 * dispatching on `--format`, not nested argv). Declared as a `choices` enum so
 * the host validates the value at mount and `graph export --format <bad>` is
 * rejected before the handler runs.
 */
export const GRAPH_EXPORT_FORMATS = ['sarif', 'catalog', 'baseline'] as const;
type GraphExportFormat = (typeof GRAPH_EXPORT_FORMATS)[number];

/**
 * Validate that the per-format required flags are present on the canonical
 * `graph export` opts. Returns `true` when the required subset is satisfied;
 * otherwise reports the missing flags (to the `--json` channel or stderr, like
 * the shared export error paths) + sets exit 2 (CONFIGURATION_ERROR) and returns
 * `false`. Keeps the per-format required-flag validation in one place, mirroring
 * the legacy commands' Commander-`required` declarations without making all
 * format-specific subsets simultaneously mandatory on one spec.
 */
function requireExportFlags(
  format: GraphExportFormat,
  present: Record<string, unknown>,
  required: readonly string[],
  cli: ToolCliContext,
): boolean {
  const missing = required.filter((flag) => {
    // Flag names map to camelCase opt keys (`--output-sarif` → `outputSarif`).
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = present[key];
    return value === undefined || value === '';
  });
  if (missing.length === 0) return true;
  const message = `graph export --format ${format} requires ${missing.join(', ')}.`;
  const exitCode = EXIT_CODES.CONFIGURATION_ERROR;
  logger.warn({ evt: 'cli.graph.export.missing_flags', module: 'graph:cli', format, missing });
  if (present.json === true) {
    cli.emitError({ message, exitCode });
    return false;
  }
  cli.setExitCode(exitCode);
  process.stderr.write(`Error: ${message}\n`);
  return false;
}

/**
 * `graph export --format sarif|catalog|baseline` — the CANONICAL graph export
 * command (tool-command-surface-taxonomy Task 2.1, spec Q2). Mounts as a
 * SUBCOMMAND of the `graph` primary (`parent: 'graph'`, via the Phase 0 Task 0.4
 * nested-mount capability), so it shares the root with `fit export` without
 * colliding (both declare `name: 'export'`).
 *
 * The three legacy flat-root commands (`sarif-export`/`catalog-export`/
 * `graph-baseline-export`) COEXIST as their own mounted commands — NOT Commander
 * `aliases([...])` — because their required-flag declarations diverge (a single
 * `export` spec cannot make all three format-specific required subsets
 * simultaneously required). All four share the same `runGraph*Export` handler
 * bodies. The canonical spec declares `--format` (required) + the UNION of the
 * legacy format-specific flags as OPTIONAL and validates the required subset per
 * format at runtime (`requireExportFlags` → ConfigurationError → exit 2).
 */
export const graphExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'export',
  parent: 'graph',
  description:
    'Export graph analysis artifacts: --format sarif (SARIF v2.1.0 findings), catalog (CatalogExport JSON), or baseline (gate fingerprint JSON)',
  commonFlags: ['cwd', 'json'],
  options: [
    {
      flag: '--format',
      value: '<fmt>',
      description: 'Export artifact: sarif | catalog | baseline',
      required: true,
      choices: [...GRAPH_EXPORT_FORMATS],
    },
    // Union of the legacy format-specific flags, all OPTIONAL here (the required
    // subset is validated per-format at runtime). The sarif/catalog variants of
    // --tenant-id/--repo-id/--run-id carry slightly different help text; the
    // canonical command uses the catalog wording (the superset flow). --cwd is a
    // common flag (declared above), so it is NOT repeated here.
    OPT_OUTPUT_SARIF,
    OPT_CATALOG_OUTPUT,
    OPT_TENANT_ID_CATALOG,
    OPT_REPO_ID_CATALOG,
    OPT_GIT_SHA,
    OPT_RUN_ID_CATALOG,
    OPT_MODE,
    OPT_CHANGED_FILE,
    OPT_LANGUAGE,
    OPT_RESOLUTION,
    OPT_BASELINE_OUT,
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as Record<string, unknown> & { format: GraphExportFormat };
    switch (opts.format) {
      case 'sarif': {
        if (!requireExportFlags('sarif', opts, ['--output-sarif', '--tenant-id', '--repo-id'], cli))
          return;
        await runGraphSarifExport(opts as unknown as GraphSarifExportOpts, cli);
        return;
      }
      case 'catalog': {
        if (
          !requireExportFlags(
            'catalog',
            opts,
            ['--catalog-output', '--tenant-id', '--repo-id', '--git-sha'],
            cli,
          )
        )
          return;
        await runGraphCatalogExport(opts as unknown as GraphCatalogExportOpts, cli);
        return;
      }
      case 'baseline': {
        if (!requireExportFlags('baseline', opts, ['--out'], cli)) return;
        await runGraphBaselineExport(
          opts as unknown as { cwd: string; out: string; json?: boolean },
          cli,
        );
        return;
      }
    }
  },
});

/**
 * `graph-recipes` — list available graph recipes (mirrors fit-recipes). Reuses
 * the shared ListRecipesResult contract + viewListRecipes renderer.
 * `command-result`: the host dispatches the returned result through the shared
 * seam (`--json` → JSON, else render).
 */
export const graphRecipesCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-recipes',
  description: 'List available graph recipes',
  commonFlags: ['json'],
  scope: 'project',
  output: 'command-result',
  handler: async () => listGraphRecipes(),
});
