/**
 * `opensip graph symbol-index --out <path>` — emit a symbol-index
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { createToolLogger, ConfigurationError, ToolError } from '@opensip-cli/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import { loadGraphConfig, runGraph } from './orchestrate.js';

import type { Catalog } from '../types.js';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const log = createToolLogger('graph:cli');

export interface SymbolIndexCommandOptions {
  readonly cwd: string;
  readonly out: string;
  /**
   * When true, run the graph pipeline first to refresh the persisted catalog
   * (Q7: build path). When false/absent, query the existing catalog only.
   */
  readonly build?: boolean;
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

export async function executeSymbolIndex(
  opts: SymbolIndexCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  log.info({
    evt: 'graph.cli.symbol-index.start',
    module: 'graph:cli',
    build: opts.build === true,
  });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError('graph symbol-index requires a DataStore on ToolCliContext.');
    }
    const catalog = await resolveCatalogForIndex(opts, datastore);
    if (!catalog) {
      throw new ConfigurationError(
        opts.build === true
          ? 'graph index --build produced no catalog.'
          : 'No graph catalog found. Run `opensip graph` or `opensip graph index --build` first.',
      );
    }
    const artifact = buildArtifact(catalog);
    const outPath = resolve(opts.cwd, opts.out);
    // Create the parent dir before writing so a nested --out
    // (e.g. reports/symbolindex.json) doesn't throw ENOENT — matches
    // the sibling writers (sarif-export, baseline-export, catalog-json).
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const symbolCount = Object.values(artifact.symbols).reduce((n, arr) => n + arr.length, 0);
    const fileCount = Object.keys(artifact.fileSymbols).length;
    process.stdout.write(
      `wrote ${String(symbolCount)} symbol(s) across ${String(fileCount)} file(s) to ${outPath}\n`,
    );
    cli.setExitCode(EXIT_CODES.SUCCESS);
    log.info({
      evt: 'graph.cli.symbol-index.complete',
      module: 'graph:cli',
      symbols: symbolCount,
      files: fileCount,
    });
  } catch (error) {
    log.error({
      evt: 'graph.cli.symbol-index.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    const exitCode =
      error instanceof ConfigurationError
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR;
    await cli.reportFailure({
      message: `graph symbol-index: ${error instanceof Error ? error.message : String(error)}`,
      exitCode,
      ...(error instanceof ToolError ? { error } : {}),
      jsonRequested: false,
    });
  }
}

async function resolveCatalogForIndex(
  opts: SymbolIndexCommandOptions,
  datastore: DataStore,
): Promise<Catalog | null> {
  if (opts.build === true) {
    const result = await runGraph({
      cwd: opts.cwd,
      datastore,
      config: loadGraphConfig(opts.cwd),
    });
    return result.catalog;
  }
  return new CatalogRepo(datastore).loadFullCatalog();
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
  bucket: readonly {
    readonly bodyHash: string;
    readonly qualifiedName: string;
    readonly filePath: string;
    readonly line: number;
    readonly column: number;
    readonly kind: string;
    readonly visibility: string;
  }[],
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
