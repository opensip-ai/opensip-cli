/**
 * dispatch-external-tool-hook — the HOST supervisor for running an EXTERNAL
 * tool's LIFECYCLE HOOK out-of-process (ADR-0054 M4-F).
 *
 * After M4-F the host never executes an external-provenance tool's lifecycle
 * hooks in-process. Two host-command hooks still need the tool's runtime to
 * produce data: `collectReportData` (the `report` command + report auto-open) and
 * `sessionReplay` (`sessions show`). For an external tool the host forks the SAME
 * `__tool-command-worker` subcommand the command dispatch uses — but in HOOK mode
 * (the spec sets `hook` instead of `commandName`). The worker imports the
 * untrusted runtime, runs the named hook against its own re-bootstrapped scope,
 * and returns the hook's plain-data result in {@link ToolCommandResult.hookResult}.
 *
 * The host gets the data WITHOUT executing the external runtime in the kernel
 * process. A fork failure / throw / timeout is a structured {@link ToolError} —
 * the host never crashes and never falls back to in-host execution.
 */

import { type ToolProvenance, type ToolSource } from '@opensip-cli/core';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  requirePackageDir,
  runWorkerSpec,
} from './dispatch-fork-core.js';
import { type DispatchHostCtx } from './dispatch-replay-result.js';

import type { ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';

export interface DispatchExternalToolHookArgs {
  /** The external tool's provenance (source must NOT be `'bundled'`). */
  readonly provenance: ToolProvenance;
  /** Which lifecycle hook to run in the worker. */
  readonly hook: NonNullable<ToolCommandWorkerSpec['hook']>;
  /** The serializable argument the hook needs (e.g. the stored session row). */
  readonly hookArg?: unknown;
  /** The project cwd the worker bootstraps against (steers discovery + project). */
  readonly cwd: string;
  /** The real host context the supervisor serves host-RPC upcalls through. */
  readonly ctx: DispatchHostCtx;
  /** Override the wall-clock timeout (tests use a short one). */
  readonly timeoutMs?: number;
  /** Override the CLI entry script the supervisor forks (defaults to argv[1]). */
  readonly cliScript?: string;
}

/**
 * Run one external tool lifecycle hook in a forked worker and return its
 * plain-data result. A worker fault becomes a structured {@link ToolError} — the
 * host never crashes; external runtime never falls back to in-host execution.
 *
 * @returns The hook's result (`hookResult`) — a `Record<string, unknown>` for
 *   `collectReportData`, a `ToolSessionReplay` for `sessionReplay`, or `undefined`
 *   when the worker tool declared no such hook.
 */
export async function dispatchExternalToolHook(
  args: DispatchExternalToolHookArgs,
): Promise<unknown> {
  const spec: ToolCommandWorkerSpec = {
    toolId: args.provenance.id,
    toolPackageDir: requirePackageDir(args.provenance),
    source: args.provenance.source as Exclude<ToolSource, 'bundled'>,
    hook: args.hook,
    // The worker resolves the project cwd from the spec opts (symmetric to the
    // command path). Hook mode carries no Commander opts/positionals.
    opts: { cwd: args.cwd },
    positionals: [],
    ...(args.hookArg === undefined ? {} : { hookArg: args.hookArg }),
  };
  const result = await runWorkerSpec({
    spec,
    ctx: args.ctx,
    cwd: args.cwd,
    ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
    timeoutMs: args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
  });
  return result.hookResult;
}
