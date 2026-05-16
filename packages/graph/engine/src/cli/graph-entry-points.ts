/**
 * `opensip-tools graph-entry-points` — print inferred entry-point set.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, logger, ToolError } from '@opensip-tools/core';

import { inferEntryPoints } from '../rules/_entry-points.js';

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
    if (!result.catalog || !result.indexes) {
      throw new Error('Pipeline produced no catalog or indexes.');
    }
    const eps = inferEntryPoints(result.catalog, result.indexes);
    const enriched = eps
      .map((ep) => {
        const occ = result.indexes!.byBodyHash.get(ep.bodyHash);
        return occ
          ? {
              simpleName: occ.simpleName,
              qualifiedName: occ.qualifiedName,
              filePath: occ.filePath,
              line: occ.line,
              kind: occ.kind,
              reason: ep.reason,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ tool: 'graph', entryPoints: enriched }, null, 2)}\n`);
    } else {
      process.stdout.write(`graph-entry-points: ${String(enriched.length)} entry point(s)\n`);
      const sorted = [...enriched].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
      for (const ep of sorted) {
        process.stdout.write(`  [${ep.reason}] ${ep.qualifiedName} (${ep.filePath}:${String(ep.line)})\n`);
      }
    }
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.graph-entry-points.complete',
      module: 'graph:cli',
      count: enriched.length,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.graph-entry-points.error',
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
    process.stderr.write(
      `graph-entry-points: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
