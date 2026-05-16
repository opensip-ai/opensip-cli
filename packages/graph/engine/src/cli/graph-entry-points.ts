/**
 * `opensip-tools graph-entry-points` — print inferred entry-point set.
 *
 * P0 ships a no-op shape; P4 wires the inference helper.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { runGraph } from './orchestrate.js';

import type { ToolCliContext } from '@opensip-tools/core';

export interface GraphEntryPointsOptions {
  readonly cwd: string;
  readonly json?: boolean;
}

export async function executeGraphEntryPoints(
  opts: GraphEntryPointsOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({
    evt: 'graph.cli.graph-entry-points.start',
    module: 'graph:cli',
    cwd: opts.cwd,
  });
  try {
    const result = await runGraph({ cwd: opts.cwd });
    const entryPoints: string[] = [];
    if (result.catalog && result.indexes) {
      // Implemented in Phase P4 — see rules/_entry-points.ts.
    }
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ entryPoints }, null, 2)}\n`);
    } else {
      process.stdout.write(`graph-entry-points: ${String(entryPoints.length)} entry point(s)\n`);
    }
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.graph-entry-points.complete',
      module: 'graph:cli',
      count: entryPoints.length,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.graph-entry-points.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph-entry-points: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
