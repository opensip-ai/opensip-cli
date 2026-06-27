/**
 * `opensip graph lookup <name>` — read-only catalog query.
 *
 * Loads the persisted catalog from the datastore and prints every
 * FunctionOccurrence whose `simpleName` matches `<name>`. Companion to
 * the file-level symbol lookup that codeindex exposes; ours operates
 * on functions and uses the existing catalog as the source of truth.
 *
 * If no catalog has been built yet, exits with CONFIGURATION_ERROR and
 * a clear "run `opensip graph` first" message — this command
 * never triggers an analysis run.
 */

import { EXIT_CODES, type CommandResult } from '@opensip-cli/contracts';
import { ConfigurationError, SystemError, ToolError, createToolLogger } from '@opensip-cli/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import { buildLookupResult } from './lookup-result.js';

import type { Catalog, FunctionOccurrence } from '../types.js';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const log = createToolLogger('graph:cli');

export interface LookupCommandOptions {
  readonly name: string;
  readonly json?: boolean;
}

export function executeLookup(opts: LookupCommandOptions, cli: ToolCliContext): CommandResult {
  log.info({ evt: 'graph.cli.lookup.start', name: opts.name });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError('lookup: graph lookup requires a DataStore on ToolCliContext.');
    }
    const catalog = new CatalogRepo(datastore).loadFullCatalog();
    if (!catalog) {
      throw new ConfigurationError(
        'lookup: No graph catalog found. Run `opensip graph` first to build the catalog.',
      );
    }
    const matches = collectMatches(catalog, opts.name);
    const resolutionMode = catalog.resolutionMode ?? 'exact';
    cli.setExitCode(EXIT_CODES.SUCCESS);
    log.info({
      evt: 'graph.cli.lookup.complete',
      matches: matches.length,
    });
    if (opts.json === true) {
      return buildLookupResult(opts.name, matches, resolutionMode);
    }
    return {
      type: 'graph-status',
      lines: humanReportLines(opts.name, matches, resolutionMode),
    };
  } catch (error) {
    log.error({
      evt: 'graph.cli.lookup.error',
      err: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof ToolError) throw error;
    throw new SystemError(`lookup: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
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
