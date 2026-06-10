// @fitness-ignore-file no-direct-stdout-in-tool-engine -- read-only auxiliary subcommand: the `--json` machine path deliberately bypasses the human render seam to emit a structured catalog-query result straight to stdout (documented inline at the call site). The human path uses cli.render. Not the signal-envelope run output.
/**
 * `opensip-tools graph lookup <name>` — read-only catalog query.
 *
 * Loads the persisted catalog from the datastore and prints every
 * FunctionOccurrence whose `simpleName` matches `<name>`. Companion to
 * the file-level symbol lookup that codeindex exposes; ours operates
 * on functions and uses the existing catalog as the source of truth.
 *
 * If no catalog has been built yet, exits with CONFIGURATION_ERROR and
 * a clear "run `opensip-tools graph` first" message — this command
 * never triggers an analysis run.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, logger } from '@opensip-tools/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import type { Catalog, FunctionOccurrence } from '../types.js';
import type { ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface LookupCommandOptions {
  readonly name: string;
  readonly json?: boolean;
}

export async function executeLookup(
  opts: LookupCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.lookup.start', module: 'graph:cli', name: opts.name });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError('graph lookup requires a DataStore on ToolCliContext.');
    }
    const catalog = new CatalogRepo(datastore).loadFullCatalog();
    if (!catalog) {
      throw new ConfigurationError(
        'No graph catalog found. Run `opensip-tools graph` first to build the catalog.',
      );
    }
    const matches = collectMatches(catalog, opts.name);
    // Absent ⇒ exact (historical catalogs predate the marker).
    const resolutionMode = catalog.resolutionMode ?? 'exact';
    if (opts.json === true) {
      // --json is the machine path: structured output straight to stdout,
      // intentionally bypassing the human render seam.
      process.stdout.write(
        `${JSON.stringify({ name: opts.name, resolutionMode, matches }, null, 2)}\n`,
      );
    } else {
      // Human path flows through the render seam (Ink on TTY, plain text in
      // pipes/CI) rather than writing to stdout directly.
      await cli.render({
        type: 'graph-status',
        lines: humanReportLines(opts.name, matches, resolutionMode),
      });
    }
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.lookup.complete',
      module: 'graph:cli',
      matches: matches.length,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.lookup.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    cli.setExitCode(
      error instanceof ConfigurationError
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR,
    );
    process.stderr.write(
      `graph lookup: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function collectMatches(catalog: Catalog, name: string): readonly FunctionOccurrence[] {
  const bucket = catalog.functions[name];
  return bucket ?? [];
}

function humanReportLines(
  name: string,
  matches: readonly FunctionOccurrence[],
  resolutionMode: 'exact' | 'fast',
): readonly string[] {
  const lines: string[] = [];
  // Honest caveat: a fast catalog's edges (callers/callees this command
  // reflects) are approximate, so the reader knows not to treat them as
  // ground truth.
  if (resolutionMode === 'fast') {
    lines.push(
      'Note: catalog built in fast mode — edges are approximate (syntactic). ' +
        'Re-run `graph --resolution exact` for semantic precision.',
    );
  }
  if (matches.length === 0) {
    lines.push(`No function named '${name}' in the catalog.`);
    return lines;
  }
  lines.push(`${name} — ${String(matches.length)} occurrence(s)`);
  for (const m of matches) {
    lines.push(
      `  ${m.qualifiedName} (${m.kind})`,
      `    ${m.filePath}:${String(m.line)}:${String(m.column)}`,
      `    bodyHash: ${m.bodyHash.slice(0, 12)}…`,
    );
  }
  return lines;
}
