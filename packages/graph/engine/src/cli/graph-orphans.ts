/**
 * `opensip-tools graph-orphans` — filter pipeline output to orphans only.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { runGraph } from './orchestrate.js';

import type { ToolCliContext } from '@opensip-tools/core';

export interface GraphOrphansOptions {
  readonly cwd: string;
  readonly json?: boolean;
}

export async function executeGraphOrphans(
  opts: GraphOrphansOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.graph-orphans.start', module: 'graph:cli', cwd: opts.cwd });
  try {
    const result = await runGraph({ cwd: opts.cwd });
    const orphans = result.signals.filter((s) => s.ruleId === 'graph:orphan-subtree');
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ tool: 'graph', signals: orphans }, null, 2)}\n`);
    } else {
      process.stdout.write(`graph-orphans: ${String(orphans.length)} orphan(s)\n`);
    }
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.graph-orphans.complete',
      module: 'graph:cli',
      orphans: orphans.length,
    });
  } catch (error) {
    logger.error({
      evt: 'graph.cli.graph-orphans.error',
      module: 'graph:cli',
      err: error instanceof Error ? error.message : String(error),
    });
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph-orphans: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
