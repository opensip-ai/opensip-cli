/**
 * `opensip-tools graph symbol-index --out <path>` — emit a symbol-index
 * JSON artifact suitable for agent consumption (e.g., feeding into a
 * coding LLM's context, or piping into another tool).
 *
 * Schema:
 *   {
 *     "version": "1.0",
 *     "tool": "graph",
 *     "generatedAt": "<ISO timestamp>",
 *     "symbols": {
 *       "<simpleName>": [
 *         { "qualifiedName", "filePath", "line", "column",
 *           "kind", "visibility", "bodyHash" },
 *         ...
 *       ]
 *     },
 *     "fileSymbols": {
 *       "<filePath>": ["<simpleName>", ...]
 *     }
 *   }
 *
 * Bidirectional like codeindex (name→file and file→names), but enriched
 * with kind/visibility/bodyHash since we already have that data.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, logger } from '@opensip-tools/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import type { Catalog } from '../types.js';
import type { ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface SymbolIndexCommandOptions {
  readonly cwd: string;
  readonly out: string;
}

interface SymbolEntry {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
  readonly visibility: string;
  readonly bodyHash: string;
}

interface SymbolIndexArtifact {
  readonly version: '1.0';
  readonly tool: 'graph';
  readonly generatedAt: string;
  readonly symbols: Record<string, readonly SymbolEntry[]>;
  readonly fileSymbols: Record<string, readonly string[]>;
}

export function executeSymbolIndex(
  opts: SymbolIndexCommandOptions,
  cli: ToolCliContext,
): void {
  logger.info({ evt: 'graph.cli.symbol-index.start', module: 'graph:cli' });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError(
        'graph symbol-index requires a DataStore on ToolCliContext.',
      );
    }
    const catalog = new CatalogRepo(datastore).loadFullCatalog();
    if (!catalog) {
      throw new ConfigurationError(
        'No graph catalog found. Run `opensip-tools graph` first to build the catalog.',
      );
    }
    const artifact = buildArtifact(catalog);
    const outPath = resolve(opts.cwd, opts.out);
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const symbolCount = Object.values(artifact.symbols).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    const fileCount = Object.keys(artifact.fileSymbols).length;
    process.stdout.write(
      `wrote ${String(symbolCount)} symbol(s) across ${String(fileCount)} file(s) to ${outPath}\n`,
    );
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.symbol-index.complete',
      module: 'graph:cli',
      symbols: symbolCount,
      files: fileCount,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.symbol-index.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    cli.setExitCode(
      error instanceof ConfigurationError
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR,
    );
    process.stderr.write(
      `graph symbol-index: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function buildArtifact(catalog: Catalog): SymbolIndexArtifact {
  const symbols: Record<string, SymbolEntry[]> = {};
  const fileSymbols: Record<string, string[]> = {};
  for (const name of Object.keys(catalog.functions)) {
    const bucket = catalog.functions[name];
    if (!bucket) continue;
    const entries = collectEntriesForName(bucket, name, fileSymbols);
    if (entries.length > 0) symbols[name] = entries;
  }
  return {
    version: '1.0',
    tool: 'graph',
    generatedAt: new Date().toISOString(),
    symbols,
    fileSymbols,
  };
}

function collectEntriesForName(
  bucket: readonly { readonly bodyHash: string; readonly qualifiedName: string;
    readonly filePath: string; readonly line: number; readonly column: number;
    readonly kind: string; readonly visibility: string }[],
  name: string,
  fileSymbols: Record<string, string[]>,
): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  for (const occ of bucket) {
    if (occ.kind === 'module-init') continue;
    entries.push({
      qualifiedName: occ.qualifiedName,
      filePath: occ.filePath,
      line: occ.line,
      column: occ.column,
      kind: occ.kind,
      visibility: occ.visibility,
      bodyHash: occ.bodyHash,
    });
    addNameToFileBucket(fileSymbols, occ.filePath, name);
  }
  return entries;
}

function addNameToFileBucket(
  fileSymbols: Record<string, string[]>,
  filePath: string,
  name: string,
): void {
  let bucket = fileSymbols[filePath];
  if (!bucket) {
    bucket = [];
    fileSymbols[filePath] = bucket;
  }
  if (!bucket.includes(name)) bucket.push(name);
}
