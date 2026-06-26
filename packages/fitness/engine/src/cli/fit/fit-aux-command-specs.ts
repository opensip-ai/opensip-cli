// @fitness-ignore-file no-direct-stdout-in-tool-engine -- auxiliary subcommand status line: `fit export --format baseline` writes the SARIF baseline to a file and prints a one-line "Exported fit baseline to <path>" confirmation (the --json path uses cli.emitJson). This is not the signal-envelope run output (ADR-0011), which routes through the composition root.
// @fitness-ignore-file only-documented-toolcli-seams -- same rationale as above: the one-line "Exported fit baseline to <path>" status confirmation after a file write; the --json path uses cli.emitJson. Not run output through a ToolCliContext seam.
/**
 * fit-aux-command-specs — the declarative `fit list` / `fit recipes` /
 * `fit export` commands (the canonical `<tool> <verb>` grammar). The host mounts
 * each spec via `mountCommandSpec`; the tool no longer touches Commander.
 *
 * The legacy flat-root aliases (`fit-list` / `fit-recipes` /
 * `fit-baseline-export`) were removed once their deprecation window closed — only
 * the nested forms remain.
 *
 * Output modes:
 *  - `fit list` / `fit recipes` → `command-result`: the handler returns the
 *    list result; the host dispatches it through the shared seam
 *    (`--json` → JSON.stringify, else render). Byte-identical to the former
 *    `if (json) cli.emitJson(result) else cli.render(result)` body, because
 *    `emitJson` and the seam's json arm both write `JSON.stringify(x, null, 2)
 *    + '\n'`.
 *  - `fit export` → `raw-stream`: an explicit file-writing command. The
 *    handler writes the SARIF baseline and prints a one-line confirmation (or an
 *    error), owning its exit-code decision and the `--json` branch itself — the
 *    documented non-Ink exception. The host renders nothing.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { createToolLogger, ConfigurationError, defineNestedCommand } from '@opensip-cli/core';

import { listChecks } from '../fit-list.js';
import { listRecipes } from '../fit-recipes.js';

import type { ToolOptions } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

const log = createToolLogger('fitness:cli');

// =============================================================================
// GROUPED <tool> <verb> CHILDREN (the canonical Tier-2 grammar)
//
// `fitness list` / `fitness recipes` mount as subcommands of the canonical
// primary, and `fit list` / `fit recipes` work through the primary alias. They
// own their handler bodies directly (calling the shared `listChecks` /
// `listRecipes` engine functions) — the legacy flat `fit-list` / `fit-recipes`
// aliases were removed.
// =============================================================================

/** `fit list` — list available fitness checks. */
export const fitListGroupedCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'list',
  description: 'List available fitness checks',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (rawOpts) => {
    const opts = rawOpts as ToolOptions;
    return listChecks(opts.cwd);
  },
});

/** `fit recipes` — list available fitness recipes. */
export const fitRecipesGroupedCommandSpec: CommandSpec<unknown, ToolCliContext> =
  defineNestedCommand<unknown, ToolCliContext>({
    name: 'recipes',
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
 * The canonical fit export formats. Single value today (`baseline`) but declared
 * as a `choices` enum so adding `sarif` later is purely additive (the host
 * validates the value at mount).
 *
 * NOTE on the `baseline` value: fitness's gate baseline is SARIF-shaped, so
 * `fit export --format baseline` writes a SARIF file. The *format value* names
 * the artifact ROLE (the gate baseline) — consistent with `graph export
 * --format baseline` (which writes JSON fingerprints) — not the file syntax.
 */
export const FIT_EXPORT_FORMATS = ['baseline'] as const;
type FitExportFormat = (typeof FIT_EXPORT_FORMATS)[number];

/**
 * Write the SQLite-backed fit gate baseline to a SARIF file at `--out` via the
 * host baseline SARIF seam (ADR-0036, Q5).
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
    log.warn({
      evt: 'cli.fit.baseline_export.failed',
      module: 'fit:cli',
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
  const result = { type: 'fit-baseline-export' as const, outPath: opts.out };
  if (opts.json) {
    cli.emitJson(result);
    return;
  }
  process.stdout.write(`Exported fit baseline to ${opts.out}\n`);
}

/**
 * `fitness export --format baseline` — the canonical fitness export command.
 * defineTool mounts this draft as a subcommand of the canonical primary, and
 * `fit export` works through the primary alias. It shares the root with
 * `graph export` without colliding because both declare `name: 'export'`.
 */
export const fitExportCommandSpec: CommandSpec<unknown, ToolCliContext> = defineNestedCommand<
  unknown,
  ToolCliContext
>({
  name: 'export',
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
    if (opts.format === 'baseline') {
      await runFitBaselineExport(opts, cli);
    }
  },
});
