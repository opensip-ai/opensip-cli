// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `graph-baseline-export` writes the JSON baseline to a file and prints a one-line "Exported graph baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
// @fitness-ignore-file detached-promises -- async command handlers invoke synchronous helpers (runCatalogJsonMode/runSarifExportMode/handleGraphError all return void); the heuristic flags them inside the async handlers. Matches the sibling graph CLI files (graph.ts, graph-modes.ts, orchestrate.ts).
/**
 * graph-aux-command-specs — the declarative graph auxiliary commands (release
 * 2.11.0 Phase 5 Task 5.2).
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

import { commonFlags } from '@opensip-tools/contracts';
import { defineCommand, logger } from '@opensip-tools/core';

import { exportGraphBaseline } from '../baseline-export.js';
import { runCatalogJsonMode } from '../graph-modes.js';
import { handleGraphError } from '../graph.js';
import { listGraphRecipes } from '../list-graph-recipes.js';
import { executeLookup } from '../lookup.js';
import { runGraph } from '../orchestrate.js';
import { runSarifExportMode } from '../sarif-export.js';
import { executeShardWorker } from '../shard-worker.js';
import { executeSymbolIndex } from '../symbol-index.js';

import type { ResolutionMode } from '../../types.js';
import type { CommandSpec, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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

/** `graph-lookup` — look up function occurrences by simple name. */
export const graphLookupCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph-lookup',
  description: 'Look up function occurrences by simple name from the persisted catalog',
  commonFlags: ['json'],
  args: [{ name: 'name', description: 'Function simple name to look up (e.g. "saveBaseline")' }],
  scope: 'project',
  output: RAW_STREAM,
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as { json?: boolean } & Record<string, unknown>;
    await executeLookup({ name: firstArg(opts), json: opts.json }, cli);
  },
});

/** `graph-shard-worker` — [internal] build one shard from a spec file. */
export const graphShardWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph-shard-worker',
  description:
    '[internal] Build one shard from a spec file and emit a ShardBuildResult JSON (spawned by the sharded build)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON ShardWorkerSpec file' }],
  scope: 'project',
  output: RAW_STREAM,
  handler: async (rawOpts, cli): Promise<void> => {
    await executeShardWorker(firstArg(rawOpts as Record<string, unknown>), cli);
  },
});

/** `graph-symbol-index` — emit a symbolindex.json artifact. */
export const graphSymbolIndexCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph-symbol-index',
  description:
    'Emit a symbolindex.json artifact (name→file:line and file→names) from the persisted catalog',
  commonFlags: [],
  options: [
    // --cwd keeps its command-specific description (the out path resolves
    // against it), so it is declared as a tool option rather than the common
    // flag. The literal default is `process.cwd()`, evaluated once at module
    // load (CLI startup) — equivalent to the former register-time evaluation.
    { flag: OPT_CWD, description: 'Target directory (out path resolves against this)', default: process.cwd() },
    { flag: '--out', value: '<path>', description: 'Output file path', default: 'symbolindex.json' },
  ],
  scope: 'project',
  output: RAW_STREAM,
  handler: (rawOpts, cli): void => {
    const opts = rawOpts as { cwd: string; out: string };
    executeSymbolIndex({ cwd: opts.cwd, out: opts.out }, cli);
  },
});

/** `graph-baseline-export` — export the graph gate baseline (JSON). */
export const graphBaselineExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph-baseline-export',
  description: 'Export the graph gate baseline (JSON) from the datastore to a file',
  commonFlags: ['cwd', 'json'],
  options: [{ flag: '--out', value: '<path>', description: 'Output file path for the JSON baseline', required: true }],
  scope: 'project',
  output: RAW_STREAM,
  handler: (rawOpts, cli): void => {
    const opts = rawOpts as { cwd: string; out: string; json?: boolean };
    const datastore = cli.scope.datastore() as DataStore;
    const result = exportGraphBaseline(datastore, opts.out);
    if (result.type === 'error') {
      cli.setExitCode(result.exitCode);
      if (opts.json === true) {
        cli.emitJson({ error: result.message });
        return;
      }
      process.stderr.write(`Error: ${result.message}\n`);
      return;
    }
    if (opts.json === true) {
      cli.emitJson(result);
      return;
    }
    process.stdout.write(
      `Exported graph baseline to ${result.outPath} ` +
        `(${String(result.fingerprintCount)} fingerprint(s), ${String(result.bytesWritten)} bytes)\n`,
    );
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
export const graphCatalogExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'catalog-export',
  description:
    'Run graph analysis and write the CatalogExport JSON document (symbols + edges + provenance) to a file',
  commonFlags: [],
  options: [
    { flag: '--catalog-output', value: '<path>', description: 'Output file path for the CatalogExport JSON', required: true },
    { flag: '--tenant-id', value: '<id>', description: 'Tenant scope stamped on every row + provenance', required: true },
    { flag: '--repo-id', value: '<id>', description: 'Repository scope stamped on every row', required: true },
    { flag: '--git-sha', value: '<sha>', description: 'Commit SHA the catalog was extracted at', required: true },
    { flag: '--run-id', value: '<uuid>', description: 'Run id for provenance (auto-generated if absent)' },
    {
      flag: '--mode',
      value: '<mode>',
      description: "'initial' (full rebuild) or 'incremental' (reuse cache when present)",
      default: 'initial',
    },
    {
      flag: '--changed-file',
      value: '<relPath>',
      description:
        'Changed file (repeatable). Advisory today — the engine derives the true changed set from fingerprint diffs; recorded for observability.',
      arrayDefault: [],
      parse: (val, prev) => [...(prev as string[]), val],
    },
    { flag: OPT_CWD, description: OPT_DESC_CWD, default: process.cwd() },
    { flag: '--language', value: '<name>', description: 'Force a specific language adapter (suppresses auto-detection)' },
    {
      flag: '--resolution',
      value: '<mode>',
      description: 'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      default: 'exact',
      choices: ['exact', 'fast'],
    },
  ],
  scope: 'project',
  output: RAW_STREAM,
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as {
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
    };
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
  },
});

/**
 * `sarif-export` — runs the pipeline and writes OpenSIP-convention SARIF to a
 * file, matching the opensip `EngineSubprocessPort.runSarifExport` contract
 * (DEC-498). Always a full run (findings, not incremental).
 */
export const graphSarifExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'sarif-export',
  description: 'Run graph analysis and write OpenSIP-convention SARIF v2.1.0 findings to a file',
  commonFlags: [],
  options: [
    { flag: '--output-sarif', value: '<path>', description: 'Output file path for the SARIF v2.1.0 document', required: true },
    { flag: '--tenant-id', value: '<id>', description: 'Tenant scope for the run', required: true },
    { flag: '--repo-id', value: '<id>', description: 'Repository scope for the run', required: true },
    { flag: '--run-id', value: '<uuid>', description: 'Run id for trace correlation (auto-generated if absent)' },
    { flag: OPT_CWD, description: OPT_DESC_CWD, default: process.cwd() },
    { flag: '--language', value: '<name>', description: 'Force a specific language adapter (suppresses auto-detection)' },
    {
      flag: '--resolution',
      value: '<mode>',
      description: 'Edge resolution tier: exact (semantic) or fast (syntactic, no type checker)',
      default: 'exact',
      choices: ['exact', 'fast'],
    },
  ],
  scope: 'project',
  output: RAW_STREAM,
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as {
      outputSarif: string;
      tenantId: string;
      repoId: string;
      runId?: string;
      cwd: string;
      language?: string;
      resolution?: string;
    };
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
  },
});

/**
 * `graph-recipes` (alias `list-graph-recipes`) — list available graph recipes
 * (mirrors fit-recipes). Reuses the shared ListRecipesResult contract +
 * viewListRecipes renderer. `command-result`: the host dispatches the returned
 * result through the shared seam (`--json` → JSON, else render).
 */
export const graphRecipesCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<unknown, ToolCliContext>({
  name: 'graph-recipes',
  description: 'List available graph recipes',
  aliases: ['list-graph-recipes'],
  commonFlags: ['json'],
  scope: 'project',
  output: 'command-result',
  handler: async () => listGraphRecipes(),
});
