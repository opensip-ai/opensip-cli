/**
 * dispatch-external-tool-command — the HOST supervisor for the out-of-process
 * external tool COMMAND dispatch plane (ADR-0054, increments M4-C / M4-D / M4-E).
 *
 * For an EXTERNAL-provenance tool command (installed / project-local /
 * user-global), the host forks the {@link executeToolCommandWorker} entry
 * instead of importing + running the handler in-process. The worker imports the
 * untrusted runtime and runs the handler; this supervisor:
 *
 *   1. marshals the minimal serializable {@link ToolCommandWorkerSpec} to a temp
 *      file and forks the worker entry via the shared {@link runWorkerSpec}
 *      fork/IPC core, which turns a child throw / `process.exit` / crash /
 *      premature-exit / fork-failure into a structured parent-side rejection,
 *      enforces the wall-clock timeout, serves the worker's host-RPC upcalls
 *      against the REAL host {@link ToolCliContext}, and inherits run correlation
 *      through the child env;
 *   2. on success, replays the slim {@link ToolCommandResult} through the REAL
 *      host seams (`render` / `emitEnvelope` / `emitJson` / `emitRaw` /
 *      `emitError` / `setExitCode`) so the output contract stays byte-identical
 *      to the in-process path.
 *
 * Bundled first-party tools never reach here — they stay in-process (the trusted
 * computing base). External tools have NO in-process fallback by trust tier
 * (ADR-0054): a fork failure is a hard, structured error, not a silent in-host
 * run.
 */

import { currentScope, SystemError, type ToolProvenance, type ToolSource } from '@opensip-cli/core';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  requirePackageDir,
  runWorkerSpec,
} from './dispatch-fork-core.js';
import { replayResult, type DispatchHostCtx } from './dispatch-replay-result.js';

import type { ToolCommandResult, ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';

export interface DispatchExternalToolCommandArgs {
  /** The external tool's provenance (source must NOT be `'bundled'`). */
  readonly provenance: ToolProvenance;
  /** Which command (by `CommandSpec.name`) to run in the worker. */
  readonly commandName: string;
  /** Parsed opts for this invocation (serializable). */
  readonly opts: Record<string, unknown>;
  /** Trailing positionals (`_args`) for this invocation (serializable). */
  readonly positionals: readonly unknown[];
  /**
   * The tool's RAW config namespace block for the WORKER deep pass (ADR-0054
   * M4-E Config two-pass). Forwarded into the spec so the worker runs the tool's
   * real Zod after load. `undefined` when there is no block to validate.
   */
  readonly config?: unknown;
  /** The real host context the supervisor replays the worker result through. */
  readonly ctx: DispatchHostCtx;
  /** Override the wall-clock timeout (tests use a short one). */
  readonly timeoutMs?: number;
  /**
   * Override the CLI entry script the supervisor forks (defaults to
   * `process.argv[1]`). The worker runs as `node <cliScript> __tool-command-worker
   * <specPath> --cwd <cwd>`, going through the full bootstrap so the dispatched
   * tool's scope (config/registries/subscope) is worker-local (ADR-0054 M4-E).
   * Tests point this at the built CLI dist entry.
   */
  readonly cliScript?: string;
}

/**
 * Fork the worker, await its slim {@link ToolCommandResult}, and replay it
 * through the host seams. A worker fault (throw / `process.exit` / crash /
 * timeout / fork failure) becomes a structured {@link ToolError} — the host never
 * crashes.
 *
 * @throws {SystemError} when the external command's provenance is `'bundled'`
 *   (a misuse — bundled tools run in-process), or when the worker fails.
 */
export async function dispatchExternalToolCommand(
  args: DispatchExternalToolCommandArgs,
): Promise<void> {
  if (args.provenance.source === 'bundled') {
    throw new SystemError(
      'dispatchExternalToolCommand called for a bundled tool; bundled tools run in-process.',
      { code: 'SYSTEM.DISPATCH.BUNDLED_MISUSE' },
    );
  }

  // Lifecycle observability: the out-of-process dispatch is a major run phase, so
  // emit a structured event onto the scope DiagnosticsBus (the same bus the
  // in-process action emits `execute` events onto). A `--json` consumer reads
  // `outcome.diagnostics.events` for context even without full OTEL.
  const diagnostics = currentScope()?.diagnostics;
  diagnostics?.event(
    'execute',
    'debug',
    `dispatching external tool '${args.provenance.id}' command '${args.commandName}' out-of-process`,
  );
  const result = await runCommandWorker(args);
  diagnostics?.event(
    'execute',
    'debug',
    `external tool '${args.provenance.id}' command '${args.commandName}' worker resolved`,
  );
  await replayResult(result, args.ctx, {
    commandName: args.commandName,
    opts: { ...args.opts, _args: args.positionals },
    positionals: args.positionals,
  });
}

/** Marshal the command spec + run it through the shared fork/IPC core. */
function runCommandWorker(args: DispatchExternalToolCommandArgs): Promise<ToolCommandResult> {
  const spec: ToolCommandWorkerSpec = {
    toolId: args.provenance.id,
    toolPackageDir: requirePackageDir(args.provenance),
    source: args.provenance.source as Exclude<ToolSource, 'bundled'>,
    commandName: args.commandName,
    opts: args.opts,
    positionals: args.positionals,
    // ADR-0054 M4-E: forward the coarse-validated config block so the worker can
    // run the tool's real Zod deep pass after load. Omitted when no block exists.
    ...(args.config === undefined ? {} : { config: args.config }),
  };
  const cwd = typeof args.opts.cwd === 'string' ? args.opts.cwd : process.cwd();
  return runWorkerSpec({
    spec,
    ctx: args.ctx,
    cwd,
    ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
    timeoutMs: args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
  });
}
