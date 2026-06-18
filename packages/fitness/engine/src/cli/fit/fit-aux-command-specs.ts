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

import { defineAuxExportCommand, defineListCommand, EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, logger } from '@opensip-cli/core';

import { listChecks } from '../fit-list.js';
import { listRecipes } from '../fit-recipes.js';

import type { ToolOptions } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

/** `fit-list` — list available fitness checks. */
export const fitListCommandSpec = defineListCommand({
  name: 'fit-list',
  description: 'List available fitness checks',
  handler: async (rawOpts) => {
    const opts = rawOpts as unknown as ToolOptions;
    return listChecks(opts.cwd);
  },
}) as CommandSpec<unknown, ToolCliContext>;

/** `fit-recipes` — list available fitness recipes. */
export const fitRecipesCommandSpec = defineListCommand({
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  handler: async (rawOpts) => {
    const opts = rawOpts as unknown as ToolOptions;
    return listRecipes(opts.cwd);
  },
}) as CommandSpec<unknown, ToolCliContext>;

/**
 * `fit-baseline-export` — write the SQLite-backed fit baseline to a SARIF file.
 *
 * `output: 'raw-stream'`: the handler owns its full IO — it writes the file and
 * prints a one-line confirmation, or sets the exit code + writes the error to
 * the `--json`/stderr channel itself. Byte-identical to the former
 * `registerBaselineExportCommand` action body.
 */
export const fitBaselineExportCommandSpec = defineAuxExportCommand({
  name: 'fit-baseline-export',
  description: 'Export the fit gate baseline (SARIF) from the datastore to a file',
  options: [
    {
      flag: '--out',
      value: '<path>',
      description: 'Output file path for the SARIF baseline',
      required: true,
    },
  ],
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as unknown as ToolOptions & { out: string };
    // ADR-0036: the host owns the SARIF export — it reconstructs a synthetic
    // envelope from the stored payloads (no stored envelope under the plane). The
    // seam throws ConfigurationError (→ exit 2) when no baseline exists.
    try {
      await cli.exportBaselineSarif('fitness', opts.out);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode =
        error instanceof ConfigurationError
          ? EXIT_CODES.CONFIGURATION_ERROR
          : EXIT_CODES.RUNTIME_ERROR;
      logger.warn({
        evt: 'cli.fit.baseline_export.failed',
        module: 'fit:cli',
        message,
        exitCode,
      });
      if (opts.json) {
        // 2.12.0 (§5.5): structured error outcome (host wraps + sets exit code).
        cli.emitError({ message, exitCode });
        return;
      }
      cli.setExitCode(exitCode);
      process.stderr.write(`Error: ${message}\n`);
      return;
    }
    const result = { type: 'fit-baseline-export' as const, outPath: opts.out };
    if (opts.json) {
      cli.emitJson(result);
      return;
    }
    process.stdout.write(`Exported fit baseline to ${opts.out}\n`);
  },
}) as CommandSpec<unknown, ToolCliContext>;
