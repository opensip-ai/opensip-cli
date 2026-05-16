/**
 * `graph` command — main action handler.
 *
 * Builds the catalog (cached when possible), runs every active rule, and
 * emits findings in the Tool-standard CliOutput shape. Gate-mode flags
 * (--gate-save / --gate-compare) shortcut into gate.ts; this handler
 * focuses on the default "build + report" path.
 */

import { runGraph } from './run.js';

import type { CliOutput } from '@opensip-tools/contracts';

export interface ExecuteGraphArgs {
  readonly cwd: string;
  readonly noCache: boolean;
}

export interface ExecuteGraphResult {
  readonly output: CliOutput;
  readonly fromCache: boolean;
  readonly cacheInvalidationReason: string | null;
}

export async function executeGraph(args: ExecuteGraphArgs): Promise<ExecuteGraphResult> {
  const result = await runGraph({ cwd: args.cwd, noCache: args.noCache });
  return {
    output: result.output,
    fromCache: result.fromCache,
    cacheInvalidationReason: result.cacheInvalidationReason,
  };
}
