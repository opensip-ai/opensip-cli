// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `fit-baseline-export` writes the SARIF baseline to a file and prints a one-line "Exported fit baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
/**
 * fit-aux-command-specs — the declarative `fit-list` / `fit-recipes` /
 * `fit-baseline-export` commands (release 2.11.0 Phase 4 Task 4.2).
 *
 * Replaces fitness's hand-rolled `registerListCommand` / `registerRecipesCommand`
 * / `registerBaselineExportCommand` bodies. The host mounts each spec via
 * `mountCommandSpec`; the tool no longer touches Commander.
 *
 * Output modes:
 *  - `fit-list` / `fit-recipes` → `command-result`: the handler returns the
 *    list result; the host dispatches it through the shared seam
 *    (`--json` → JSON.stringify, else render). Byte-identical to the former
 *    `if (json) cli.emitJson(result) else cli.render(result)` body, because
 *    `emitJson` and the seam's json arm both write `JSON.stringify(x, null, 2)
 *    + '\n'`.
 *  - `fit-baseline-export` → `raw-stream`: an explicit file-writing command. The
 *    handler writes the SARIF baseline and prints a one-line confirmation (or an
 *    error), owning its exit-code decision and the `--json` branch itself — the
 *    documented non-Ink exception. The host renders nothing.
 */

import { defineCommand } from '@opensip-tools/core';

import { exportFitBaseline } from '../baseline-export.js';
import { listChecks } from '../list-checks.js';
import { listRecipes } from '../list-recipes.js';

import type { ToolOptions } from '@opensip-tools/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

/** `fit-list` (alias `list-checks`) — list available fitness checks. */
export const fitListCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-list',
  description: 'List available fitness checks',
  aliases: ['list-checks'],
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listChecks(opts.cwd);
  },
});

/** `fit-recipes` (alias `list-recipes`) — list available fitness recipes. */
export const fitRecipesCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  aliases: ['list-recipes'],
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listRecipes(opts.cwd);
  },
});

/**
 * `fit-baseline-export` — write the SQLite-backed fit baseline to a SARIF file.
 *
 * `output: 'raw-stream'`: the handler owns its full IO — it writes the file and
 * prints a one-line confirmation, or sets the exit code + writes the error to
 * the `--json`/stderr channel itself. Byte-identical to the former
 * `registerBaselineExportCommand` action body.
 */
export const fitBaselineExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-baseline-export',
  description: 'Export the fit gate baseline (SARIF) from the datastore to a file',
  commonFlags: ['cwd', 'json'],
  options: [
    { flag: '--out', value: '<path>', description: 'Output file path for the SARIF baseline', required: true },
  ],
  scope: 'project',
  output: 'raw-stream',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as ToolOptions & { out: string };
    const datastore = cli.scope.datastore() as DataStore;
    const result = await exportFitBaseline(datastore, opts.out, cli);
    if (result.type === 'error') {
      if (opts.json) {
        // 2.12.0 (§5.5): structured error outcome (host wraps + sets exit code).
        cli.emitError({ message: result.message, exitCode: result.exitCode });
        return;
      }
      cli.setExitCode(result.exitCode);
      process.stderr.write(`Error: ${result.message}\n`);
      return;
    }
    if (opts.json) {
      cli.emitJson(result);
      return;
    }
    process.stdout.write(`Exported fit baseline to ${result.outPath}\n`);
  },
});
