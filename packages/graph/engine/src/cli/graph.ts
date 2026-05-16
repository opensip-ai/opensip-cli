/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline; renders Signals as table or JSON; surfaces
 * exit code via cli.setExitCode. P0 prints a no-op message; later
 * phases enrich.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { runGraph } from './orchestrate.js';

import type { ToolCliContext } from '@opensip-tools/core';

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
      const payload = {
        tool: 'graph',
        signals: result.signals,
        cacheHit: result.cacheHit,
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(
        `graph: pipeline ran (signals=${String(result.signals.length)}, cacheHit=${String(result.cacheHit)})\n`,
      );
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
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(`graph: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
