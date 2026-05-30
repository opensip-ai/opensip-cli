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

export function executeLookup(opts: LookupCommandOptions, cli: ToolCliContext): void {
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
      process.stdout.write(
        `${JSON.stringify({ name: opts.name, resolutionMode, matches }, null, 2)}\n`,
      );
    } else {
      writeHumanReport(opts.name, matches, resolutionMode);
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

function writeHumanReport(
  name: string,
  matches: readonly FunctionOccurrence[],
  resolutionMode: 'exact' | 'fast',
): void {
  // Honest caveat: a fast catalog's edges (callers/callees this command
  // reflects) are approximate, so the reader knows not to treat them as
  // ground truth.
  if (resolutionMode === 'fast') {
    process.stdout.write(
      'Note: catalog built in fast mode — edges are approximate (syntactic). ' +
        'Re-run `graph --resolution exact` for semantic precision.\n',
    );
  }
  if (matches.length === 0) {
    process.stdout.write(`No function named '${name}' in the catalog.\n`);
    return;
  }
  process.stdout.write(`${name} — ${String(matches.length)} occurrence(s)\n`);
  for (const m of matches) {
    process.stdout.write(`  ${m.qualifiedName} (${m.kind})\n`);
    process.stdout.write(
      `    ${m.filePath}:${String(m.line)}:${String(m.column)}\n`,
    );
    process.stdout.write(`    bodyHash: ${m.bodyHash.slice(0, 12)}…\n`);
  }
}
