// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `fit-baseline-export` writes the SARIF baseline to a file and prints a one-line "Exported fit baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
// @fitness-ignore-file only-documented-toolcli-seams -- same rationale as above: the one-line "Exported fit baseline to <path>" status confirmation after a file write; the --json path uses cli.emitJson. Not run output through a ToolCliContext seam.
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

import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, defineCommand, logger } from '@opensip-cli/core';

import { listChecks } from '../fit-list.js';
import { listRecipes } from '../fit-recipes.js';

import type { ToolOptions } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

/** `fit-list` — list available fitness checks. */
export const fitListCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-list',
  description: 'List available fitness checks',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listChecks(opts.cwd);
  },
});

/** `fit-recipes` — list available fitness recipes. */
export const fitRecipesCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listRecipes(opts.cwd);
  },
});

/**
 * The canonical fit export formats (tool-command-surface-taxonomy Task 2.2).
 * Single value today (`baseline`) but declared as a `choices` enum so adding
 * `sarif` later is purely additive (the host validates the value at mount).
 *
 * NOTE on the `baseline` value: fitness's gate baseline is SARIF-shaped, so
 * `fit export --format baseline` writes a SARIF file. The *format value* names
 * the artifact ROLE (the gate baseline) — consistent with `graph export
 * --format baseline` (which writes JSON fingerprints) — not the file syntax.
 */
export const FIT_EXPORT_FORMATS = ['baseline'] as const;
type FitExportFormat = (typeof FIT_EXPORT_FORMATS)[number];

/** The legacy-alias telemetry event name (Task 2.3) — shared across tools so a
 *  single query counts deprecated-export usage. */
const LEGACY_ALIAS_EVENT = 'cli.command.legacy_alias_used';

/**
 * Write the SQLite-backed fit gate baseline to a SARIF file at `--out` via the
 * host baseline SARIF seam (ADR-0036, Q5). Shared by the canonical `fit export
 * --format baseline` command and the legacy `fit-baseline-export` alias.
 *
 * The host reconstructs a synthetic envelope from the stored payloads (no stored
 * envelope under the plane). The seam throws ConfigurationError (→ exit 2) when
 * no baseline exists; this maps it for both the `--json` and stderr boundaries.
 */
async function runFitBaselineExport(
  opts: ToolOptions & { out: string },
  cli: ToolCliContext,
): Promise<void> {
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
}

/**
 * `fit export --format baseline` — the CANONICAL fitness export command
 * (tool-command-surface-taxonomy Task 2.2). Mounts as a SUBCOMMAND of the `fit`
 * primary (`parent: 'fit'`, via the Phase 0 nested-mount capability), so it
 * shares the root with `graph export` without colliding (both declare
 * `name: 'export'`). The legacy `fit-baseline-export` command coexists.
 */
export const fitExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'export',
  parent: 'fit',
  description: 'Export fit artifacts: --format baseline (the SARIF-shaped gate baseline)',
  commonFlags: ['cwd', 'json'],
  options: [
    {
      flag: '--format',
      value: '<fmt>',
      description: 'Export artifact: baseline (the SARIF-shaped gate baseline)',
      required: true,
      choices: [...FIT_EXPORT_FORMATS],
    },
    {
      flag: '--out',
      value: '<path>',
      description: 'Output file path for the SARIF baseline',
      required: true,
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as ToolOptions & { out: string; format: FitExportFormat };
    // Dispatch on --format (single value today; a `switch` would trip
    // sonarjs/no-small-switch). `baseline` → the shared SARIF baseline body.
    // Adding `sarif` later is one more branch here + a FIT_EXPORT_FORMATS entry.
    if (opts.format === 'baseline') {
      await runFitBaselineExport(opts, cli);
    }
  },
});

/**
 * `fit-baseline-export` — write the SQLite-backed fit baseline to a SARIF file.
 * Legacy flat-root alias of `fit export --format baseline` (coexists with
 * `legacy_alias_used` telemetry).
 *
 * `output: 'raw-stream'`: the shared `runFitBaselineExport` body owns its full
 * IO — it writes the file and prints a one-line confirmation, or sets the exit
 * code + writes the error to the `--json`/stderr channel itself.
 */
export const fitBaselineExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-baseline-export',
  description: 'Export the fit gate baseline (SARIF) from the datastore to a file',
  commonFlags: ['cwd', 'json'],
  options: [
    {
      flag: '--out',
      value: '<path>',
      description: 'Output file path for the SARIF baseline',
      required: true,
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'file-export',
  handler: async (rawOpts, cli): Promise<void> => {
    const opts = rawOpts as ToolOptions & { out: string };
    // Task 2.3: deprecated-command telemetry (canonical: `fit export --format
    // baseline`). Side log only — no behaviour/exit-code change.
    logger.info({
      evt: LEGACY_ALIAS_EVENT,
      module: 'fit:cli',
      legacyCommand: 'fit-baseline-export',
      canonical: 'fit export --format baseline',
    });
    await runFitBaselineExport(opts, cli);
  },
});
