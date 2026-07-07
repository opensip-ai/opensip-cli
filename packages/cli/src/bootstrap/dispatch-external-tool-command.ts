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

import { currentScope, SystemError, type ToolSource } from '@opensip-cli/core';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  requirePackageDir,
  runWorkerSpec,
} from './dispatch-fork-core.js';
import { replayResult } from './dispatch-replay-result.js';
import {
  runExternalAdapterLiveView,
  shouldUseExternalAdapterLiveView,
} from './external-adapter-live-view.js';

import type { DispatchExternalToolCommandArgs } from './dispatch-external-tool-command-types.js';
import type { ToolCommandResult, ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';

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
  if (shouldUseExternalAdapterLiveView(args)) {
    await runExternalAdapterLiveView(args);
    diagnostics?.event(
      'execute',
      'debug',
      `external tool '${args.provenance.id}' command '${args.commandName}' live view resolved`,
    );
    return;
  }
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
    ...(args.presentationMode === undefined ? {} : { presentationMode: args.presentationMode }),
  };
  const cwd = typeof args.opts.cwd === 'string' ? args.opts.cwd : process.cwd();
  return runWorkerSpec({
    spec,
    ctx: args.ctx,
    cwd,
    ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
    timeoutMs: args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
    ...(args.onAdapterProgress === undefined ? {} : { onAdapterProgress: args.onAdapterProgress }),
  });
}
