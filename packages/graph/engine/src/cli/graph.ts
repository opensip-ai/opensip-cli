/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline; renders Signals as table or JSON; surfaces
 * exit code via cli.setExitCode. Per DEC-8, a switch in this handler
 * dispatches to the right renderer.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, logger, ToolError } from '@opensip-tools/core';

import { renderJson } from '../render/json.js';
import { renderTable } from '../render/table.js';

import { runGraph } from './orchestrate.js';

import type { Catalog } from '../types.js';
import type { ToolCliContext } from '@opensip-tools/core';

function countFiles(catalog: Catalog): number {
  const files = new Set<string>();
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) files.add(o.filePath);
  }
  return files.size;
}

function countOccurrences(catalog: Catalog): number {
  let n = 0;
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (occs) n += occs.length;
  }
  return n;
}

export interface GraphCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly noCache?: boolean;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly baseline?: string;
  readonly reportTo?: string;
}

export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.graph.start', module: 'graph:cli', cwd: opts.cwd });
  try {
    const result = await runGraph({ cwd: opts.cwd, noCache: opts.noCache });
    if (opts.json === true) {
      logger.info({ evt: 'graph.render.json.start', module: 'graph:render' });
      const out = renderJson(result.signals, { cwd: opts.cwd, tool: 'graph', command: 'graph' });
      process.stdout.write(`${out}\n`);
      logger.info({ evt: 'graph.render.json.complete', module: 'graph:render' });
    } else {
      logger.info({ evt: 'graph.render.table.start', module: 'graph:render' });
      if (result.catalog) {
        const fileCount = countFiles(result.catalog);
        const fnCount = countOccurrences(result.catalog);
        process.stdout.write(
          `graph: inventory built (${String(fnCount)} functions across ${String(fileCount)} files); cacheHit=${String(result.cacheHit)}\n`,
        );
      }
      const out = renderTable(result.signals, { cwd: opts.cwd, tool: 'graph', command: 'graph' });
      process.stdout.write(out);
      logger.info({ evt: 'graph.render.table.complete', module: 'graph:render' });
    }
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.graph.complete',
      module: 'graph:cli',
      signals: result.signals.length,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.graph.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof ConfigurationError) {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    } else if (error instanceof ToolError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    }
    process.stderr.write(`graph: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
