// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `graph export --format baseline` writes the JSON baseline to a file and prints a one-line "Exported graph baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.

// @fitness-ignore-file only-documented-toolcli-seams -- same rationale as the no-direct-stdout waiver above: the one-line "Exported graph baseline to <path>" status confirmation after a file write; the --json path uses cli.emitJson. Not run output through a ToolCliContext seam.
/**
 * graph-aux-command-specs — the declarative graph auxiliary commands.
 *
 * The host mounts each spec via `mountCommandSpec`; the tool no longer touches
 * Commander. Each helper's raw `.option()`/`.argument()` calls translate 1:1 to
 * `OptionSpec`/`ArgSpec`; positional arguments arrive on the parsed-opts object
 * under the `_args` key (the host's uniform positional convention — see
 * `mountCommandSpec`).
 *
 * The canonical surface is the nested `<tool> <verb>` grammar — `graph recipes`
 * / `graph lookup` / `graph index` / `graph list` / `graph export` all mount as
 * children of the `graph` primary (`parent: 'graph'`). The legacy flat-root
 * aliases (`graph-recipes` / `graph-lookup` / `graph-symbol-index` /
 * `graph-baseline-export` / `catalog-export` / `sarif-export`) were removed once
 * their deprecation window closed.
 *
 * Output modes:
 *  - `graph recipes` / `graph list` → `command-result`: the handler returns the
 *    list result; the host dispatches it through the shared seam (`--json` →
 *    JSON, else render). Byte-identical to the former `if (json) emitJson else
 *    render` body.
 *  - every other aux command → `raw-stream`: each owns its full IO (writes a
 *    file and/or prints a line, sets its own exit code, owns its `--json`
 *    branch) — the documented non-Ink exception. The host renders nothing.
 */

import { commonFlags, EXIT_CODES } from '@opensip-cli/contracts';
import {
  createToolLogger,
  ConfigurationError,
  defineCommand,
  defineNestedCommand,
} from '@opensip-cli/core';

import { executeEquivalenceCheck } from '../equivalence-check-command.js';
import { listGraphRules } from '../graph-list.js';
import { runCatalogJsonMode } from '../graph-modes.js';
import { listGraphRecipes } from '../graph-recipes.js';
import { handleGraphError } from '../graph.js';
import { executeImpact } from '../impact.js';
import { executeLookup } from '../lookup.js';
import { runGraph } from '../orchestrate.js';
import { runSarifExportMode } from '../sarif-export.js';
import { executeShardWorker } from '../shard-worker.js';
import { executeSymbolIndex } from '../symbol-index.js';

import type { ResolutionMode } from '../../types.js';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const log = createToolLogger('graph:cli');

// Shared --cwd flag string for the auxiliary subcommands that declare it as a
// tool option (the index command keeps a custom description). Sourced from the
// ADR-0021 common-flag registry so the string matches the run command's --cwd
// and cannot drift.
const OPT_CWD = commonFlags.cwd.flags;

// Shared output mode for the file-/stdout-writing aux commands. Extracted to a
// const so the literal is declared once (sonarjs/no-duplicate-string) and stays
// a typed CommandOutputMode member.
const RAW_STREAM = 'raw-stream' as const;

// Shared `rawStreamReason` for the file-writing aux commands (the index command
// + the canonical `graph export`). Declared once so the literal is not
// duplicated (sonarjs/no-duplicate-string).
const REASON_FILE_EXPORT = 'file-export' as const;

/** Read the single trailing positional (`<name>` / `<specPath>`) off the parsed opts. */
function firstArg(opts: Record<string, unknown>): string {
  const args = (opts._args ?? []) as readonly string[];
  return args[0] ?? '';
}

// =============================================================================
// EXPORT OPTION SPECS (the canonical `graph export --format <fmt>` command)
//
// The canonical `graph export` command declares `--format <fmt>` (required) plus
// the UNION of the per-format flags as OPTIONAL and validates the required
// subset per format at runtime. Each OptionSpec is declared once here.
// =============================================================================

/** `--out` for the baseline export — JSON fingerprints. */
const OPT_BASELINE_OUT = {
  flag: '--out',
  value: '<path>',
  description: 'Output file path for the JSON baseline',
} as const;

/** `--catalog-output` (catalog export). */
const OPT_CATALOG_OUTPUT = {
  flag: '--catalog-output',
  value: '<path>',
  description: 'Output file path for the CatalogExport JSON',
} as const;

/** `--output-sarif` (sarif export). */
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

/** `--repo-id` (catalog/sarif export). */
const OPT_REPO_ID_CATALOG = {
  flag: '--repo-id',
  value: '<id>',
  description: 'Repository scope stamped on every row',
} as const;

/** `--git-sha` (catalog export). */
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

/** `--mode` (catalog export). */
const OPT_MODE = {
  flag: '--mode',
  value: '<mode>',
  description: "'initial' (full rebuild) or 'incremental' (reuse cache when present)",
  default: 'initial',
} as const;

/** `--changed-file` (catalog export) — repeatable accumulator. */
const OPT_CHANGED_FILE = {
  flag: '--changed-file',
  value: '<relPath>',
  description:
    'Changed file (repeatable). Advisory today — the engine derives the true changed set from fingerprint diffs; recorded for observability.',
  arrayDefault: [] as readonly string[],
  parse: (val: string, prev: unknown) => [...(prev as string[]), val],
} as const;

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
// EXPORT HANDLER BODIES (used by the canonical `graph export` spec)
//
// The `graph export` spec validates the per-format required flag subset BEFORE
// delegating to these bodies.
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
    await handleGraphError('sarif-export', error, cli);
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
      log.info({
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
    await runCatalogJsonMode(
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
    await handleGraphError('catalog-export', error, cli);
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
    log.warn({
      evt: 'cli.graph.baseline_export.failed',
      module: 'graph:cli',
      message,
      exitCode,
    });
    await cli.reportFailure({
      message,
      exitCode,
      jsonRequested: opts.json === true,
    });
    return;
  }
  const result = { type: 'graph-baseline-export' as const, outPath: opts.out };
  if (opts.json === true) {
    cli.emitJson(result);
    return;
  }
  process.stdout.write(`Exported graph baseline to ${opts.out}\n`);
}

/** `graph-shard-worker` — [internal] build one shard from a spec file. */
export const graphShardWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-shard-worker',
  visibility: 'internal',
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
  visibility: 'internal',
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
    const opts = rawOpts as {
      cwd: string;
      budget?: string;
      updateBudget?: boolean;
    };
    await executeEquivalenceCheck(
      { cwd: opts.cwd, budget: opts.budget, updateBudget: opts.updateBudget },
      cli,
    );
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

/** Flag names map to camelCase opt keys (`--output-sarif` → `outputSarif`). */
function exportFlagKey(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Return required `graph export` flags that are absent or empty on `present`.
 * Keeps per-format validation in one place without making every subset mandatory
 * on the shared export spec.
 */
function missingExportFlags(
  present: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter((flag) => {
    const value = present[exportFlagKey(flag)];
    return value === undefined || value === '';
  });
}

function reportMissingExportFlags(
  format: GraphExportFormat,
  present: Record<string, unknown>,
  missing: readonly string[],
  cli: ToolCliContext,
): Promise<void> {
  const message = `graph export --format ${format} requires ${missing.join(', ')}.`;
  log.warn({
    evt: 'cli.graph.export.missing_flags',
    module: 'graph:cli',
    format,
    missing,
  });
  return cli.reportFailure({
    message,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    jsonRequested: present.json === true,
  });
}

const SARIF_EXPORT_REQUIRED_FLAGS = ['--output-sarif', '--tenant-id', '--repo-id'] as const;
const CATALOG_EXPORT_REQUIRED_FLAGS = [
  '--catalog-output',
  '--tenant-id',
  '--repo-id',
  '--git-sha',
] as const;
const BASELINE_EXPORT_REQUIRED_FLAGS = ['--out'] as const;

interface GraphExportGuard<TOpts> {
  readonly format: GraphExportFormat;
  readonly requiredFlags: readonly string[];
  readonly opts: TOpts;
  readonly present: Record<string, unknown>;
  readonly cli: ToolCliContext;
  readonly run: (opts: TOpts, cli: ToolCliContext) => Promise<void>;
}

function runGraphExportGuarded<TOpts>({
  format,
  requiredFlags,
  opts,
  present,
  cli,
  run,
}: GraphExportGuard<TOpts>): Promise<void> {
  const missing = missingExportFlags(present, requiredFlags);
  if (missing.length > 0) return reportMissingExportFlags(format, present, missing, cli);
  return run(opts, cli);
}

/**
 * `graph export --format sarif|catalog|baseline` — the canonical graph export
 * command (taxonomy spec Q2). Mounts as a SUBCOMMAND of the `graph` primary
 * (`parent: 'graph'`, via the nested-mount capability), so it shares the root
 * with `fit export` without colliding (both declare `name: 'export'`).
 *
 * The legacy flat-root commands (`sarif-export`/`catalog-export`/
 * `graph-baseline-export`) were removed. The canonical spec declares `--format`
 * (required) + the UNION of the per-format flags as OPTIONAL and validates the
 * required subset per format at runtime (`missingExportFlags` →
 * `reportFailure` → exit 2).
 */
export const graphExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'export',
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
    // Union of the per-format flags, all OPTIONAL here (the required subset is
    // validated per-format at runtime). --cwd is a common flag (declared above),
    // so it is NOT repeated here.
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
  rawStreamReason: REASON_FILE_EXPORT,
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as Record<string, unknown> & {
      format: GraphExportFormat;
    };
    switch (opts.format) {
      case 'sarif': {
        await runGraphExportGuarded({
          format: 'sarif',
          requiredFlags: SARIF_EXPORT_REQUIRED_FLAGS,
          opts: opts as unknown as GraphSarifExportOpts,
          present: opts,
          cli,
          run: runGraphSarifExport,
        });
        return;
      }
      case 'catalog': {
        await runGraphExportGuarded({
          format: 'catalog',
          requiredFlags: CATALOG_EXPORT_REQUIRED_FLAGS,
          opts: opts as unknown as GraphCatalogExportOpts,
          present: opts,
          cli,
          run: runGraphCatalogExport,
        });
        return;
      }
      case 'baseline': {
        await runGraphExportGuarded({
          format: 'baseline',
          requiredFlags: BASELINE_EXPORT_REQUIRED_FLAGS,
          opts: opts as unknown as {
            cwd: string;
            out: string;
            json?: boolean;
          },
          present: opts,
          cli,
          run: runGraphBaselineExport,
        });
        return;
      }
    }
  },
});

// =============================================================================
// GROUPED <tool> <verb> CHILDREN (the canonical Tier-2 grammar)
//
// `graph recipes` / `graph lookup` / `graph index` / `graph list` mount as
// SUBCOMMANDS of the `graph` primary via the nested-mount capability
// (`parent: 'graph'`). They own their handler bodies directly (calling the
// shared engine functions) — the legacy flat `graph-recipes` / `graph-lookup` /
// `graph-symbol-index` aliases were removed.
// =============================================================================

/**
 * `graph recipes` — list available graph recipes (mirrors `fit recipes`). Reuses
 * the shared ListRecipesResult contract + viewListRecipes renderer.
 * `command-result`: the host dispatches the returned result through the shared
 * seam (`--json` → JSON, else render).
 */
export const graphRecipesGroupedCommandSpec: CommandSpec<unknown, ToolCliContext> =
  defineNestedCommand<unknown, ToolCliContext>({
    name: 'recipes',
    description: 'List available graph recipes',
    commonFlags: ['json'],
    scope: 'project',
    output: 'command-result',
    handler: async () => listGraphRecipes(),
  });

/** `graph lookup <name>` — look up function occurrences by simple name. */
export const graphLookupGroupedCommandSpec: CommandSpec<unknown, ToolCliContext> =
  defineNestedCommand<unknown, ToolCliContext>({
    name: 'lookup',
    description: 'Look up function occurrences by simple name from the persisted catalog',
    commonFlags: ['json', 'cwd'],
    args: [
      {
        name: 'name',
        description: 'Function simple name to look up (e.g. "saveBaseline")',
      },
    ],
    scope: 'project',
    output: 'command-result',
    handler: (rawOpts, cli) => {
      const opts = rawOpts as { json?: boolean } & Record<string, unknown>;
      return executeLookup({ name: firstArg(opts), json: opts.json }, cli);
    },
  });

/**
 * `graph index` — emit a `symbolindex.json` artifact (name→file:line and
 * file→names). Default (query): read the persisted catalog only. `--build`:
 * run the graph pipeline first, then emit from the refreshed catalog (Q7).
 */
export const graphIndexGroupedCommandSpec: CommandSpec<unknown, ToolCliContext> =
  defineNestedCommand<unknown, ToolCliContext>({
    name: 'index',
    description:
      'Emit a symbolindex.json artifact (name→file:line and file→names); --build refreshes the catalog first',
    commonFlags: [],
    options: [
      {
        flag: '--build',
        description: 'Run the graph pipeline to refresh the catalog before emitting the index',
        default: false,
      },
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
    rawStreamReason: REASON_FILE_EXPORT,
    handler: async (rawOpts, cli): Promise<void> => {
      const opts = rawOpts as { cwd: string; out: string; build?: boolean };
      await executeSymbolIndex({ cwd: opts.cwd, out: opts.out, build: opts.build }, cli);
    },
  });

/**
 * `graph list` — list available graph rules (the natural analog of `fit list`,
 * which lists checks): graph *rules* are the listable surface.
 *
 * `command-result`: the handler returns a `ListChecksResult`; the host
 * dispatches it through the shared seam (`--json` → JSON, else the shared
 * `viewListChecks` renderer with the graph-supplied title) — the same path
 * `graph recipes` / `fit list` use.
 */
export const graphListCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'list',
  description: 'List available graph rules',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async () => listGraphRules(),
});

/** `graph impact` — changed→impact analysis over the persisted catalog (ADR-0085). */
export const graphImpactCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'impact',
  description:
    'Analyze what changed and what depends on it (git --changed/--since or explicit --files)',
  commonFlags: ['cwd', 'json'],
  options: [
    {
      flag: '--changed',
      description: 'Use git working-tree / branch diff for changed files',
      default: false,
    },
    {
      flag: '--since',
      value: '<ref>',
      description: 'Git ref base (diff <ref>...HEAD); implies changed semantics',
    },
    {
      flag: '--files',
      value: '<path>',
      description: 'Explicit changed file (repeatable; git-free)',
      arrayDefault: [] as readonly string[],
      parse: (val: string, prev: unknown) => [...(prev as string[]), val],
    },
    {
      flag: '--top',
      value: '<n>',
      description: 'Cap impacted function count',
    },
    {
      flag: '--raw',
      description: 'Emit unwrapped payload (no CommandOutcome wrapper)',
      default: false,
    },
    {
      flag: '--no-cache',
      description: 'Force catalog rebuild before impact analysis',
      default: false,
    },
  ],
  scope: 'project',
  output: RAW_STREAM,
  rawStreamReason: 'runtime-render-dispatch',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as {
      cwd: string;
      json?: boolean;
      raw?: boolean;
      changed?: boolean;
      since?: string;
      top?: string;
      noCache?: boolean;
    };
    await executeImpact(
      {
        cwd: opts.cwd,
        json: opts.json,
        raw: opts.raw,
        changed: opts.changed,
        since: opts.since,
        files: (opts as { files?: string[] }).files,
        top: opts.top,
        noCache: opts.noCache,
      },
      cli,
    );
  },
});
