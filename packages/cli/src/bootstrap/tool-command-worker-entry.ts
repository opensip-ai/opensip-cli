/**
 * tool-command-worker-entry — the WORKER side of the out-of-process external
 * tool command dispatch plane (ADR-0054, increments M4-C / M4-D / M4-E).
 *
 * This is a HOST internal `CommandSpec` (`__tool-command-worker`), forked by the
 * supervisor as `node <cliScript> __tool-command-worker <specPath> --cwd <cwd>`.
 * Forking the CLI binary as a subcommand (the SAME pattern graph's
 * `graph-run-worker` uses) means the FULL CLI bootstrap runs first: the preAction
 * hook discovers + imports the external tool runtime IN THE WORKER, registers it,
 * runs its `contributeScope`, composes + validates config, and builds the full
 * per-run scope — so by the time this handler runs, `currentScope()` carries the
 * tool's subscope (`scope.fitness`/…), the check/recipe registries, project
 * context, and `toolConfig` exactly as an in-process run (ADR-0054 M4-C `scope`
 * mapping: "the worker re-bootstraps its OWN scope … exactly like graph's
 * worker"). This is the isolation move — the untrusted runtime loads HERE, in the
 * worker, never in the host.
 *
 * The handler then resolves the dispatched tool from the re-bootstrapped registry
 * and runs ITS command handler against the WORKER-side `ToolCliContext` shim
 * (`tool-command-worker-context.ts`): FRR seams (render/json/envelope/raw/error/
 * exit) record the value and return it once in the {@link ToolCommandResult}; the
 * host-RPC seams (egress / SARIF / baselines / toolState / hostPlanes /
 * report-open / exit-code re-affirm) UPCALL the host over the rpc-reply channel
 * (the host performs the privileged effect — network/FS/exit stay host-owned).
 * The ambient RunScope datastore thunk is DENIED in workers (ADR-0145 /
 * `host-rpc-only`): `cli.scope.datastore()` and `currentScope().datastore()` fail
 * loud with PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS. Only the live-view seams fail
 * loud as `unsupported-seam`.
 *
 * A handler that calls `process.exit`, throws, crashes the native layer, or spins
 * the event loop is contained: the supervisor turns a premature child exit /
 * timeout / `error` message into a structured parent-side failure, and the host
 * process survives.
 */

import { readFileSync } from 'node:fs';

import {
  assertCapturedOutputFits,
  canonicalToolErrorCode,
  createRunTimer,
  currentScope,
  defineCommand,
  getWorkerLimits,
  IpcPayloadTooLargeError,
  resolveToolHooks,
  sendWorkerIpcMessage,
  sendWorkerIpcMessageAndDrain,
  startWorkerHeartbeat,
  ToolError,
  type CommandSpec,
  type Tool,
  type ToolSessionRecord,
  type WorkerMessage,
} from '@opensip-cli/core';

import { type CliCommandsContext } from '../commands/shared.js';

import { loadOwningToolCapabilities } from './load-tool-capabilities.js';
import { runDeepConfigPass } from './tool-command-worker-config-pass.js';
import { buildWorkerContext, type ResultAccumulator } from './tool-command-worker-context.js';
import {
  classifyThrow,
  findCommandSpec,
  resolveTool,
  runWorkerInitialize,
} from './tool-command-worker-resolve.js';
import {
  assertReturnValuedHandlerResult,
  toResult,
  type MaybeCompletion,
} from './tool-command-worker-result.js';
import { createWorkerRpcClient } from './tool-command-worker-rpc.js';

import type {
  DispatchProgressEvent,
  ToolCommandFailureClass,
  ToolCommandResult,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';
import type { ExternalAdapterProgressEvent } from '@opensip-cli/external-tool-adapter';

/**
 * The worker's IPC message type binding: host-RPC requests stream on the
 * `progress` arm; the final {@link ToolCommandResult} settles `result`.
 */
type DispatchWorkerMessage = WorkerMessage<DispatchProgressEvent, ToolCommandResult>;

/** Post one IPC message to the parent (no-op when not forked — e.g. a unit call). */
function send(msg: DispatchWorkerMessage): void {
  try {
    sendWorkerIpcMessage(msg);
  } catch (error) {
    if (error instanceof IpcPayloadTooLargeError) {
      process.send?.({
        kind: 'error',
        message: error.message,
        failureClass: 'payload_too_large',
      });
      return;
    }
    throw error;
  }
}

/**
 * Terminal IPC send — drains before the worker process exits so the parent
 * does not race `exit` ahead of `message` under load (the 61849de7 race,
 * closed here for the external-tool dispatch path). Progress/host-RPC sends
 * stay synchronous; only the final result/error needs the drain.
 */
async function sendTerminal(msg: DispatchWorkerMessage): Promise<void> {
  try {
    await sendWorkerIpcMessageAndDrain(msg);
  } catch (error) {
    if (error instanceof IpcPayloadTooLargeError) {
      await sendWorkerIpcMessageAndDrain({
        kind: 'error',
        message: error.message,
        failureClass: 'payload_too_large',
      });
      return;
    }
    throw error;
  }
}

/**
 * Build a structured `error` IPC message with a failure class (+ stack when
 * present). `code` carries the canonical exit class while `detailCode` carries
 * the original stable subcode, so the supervisor can rebuild the right subclass
 * without discarding machine-readable capability diagnostics.
 */
function errorMessage(
  message: string,
  failureClass: ToolCommandFailureClass,
  stack?: string,
  code?: string,
  detailCode?: string,
): DispatchWorkerMessage {
  return {
    kind: 'error',
    message,
    failureClass,
    ...(stack === undefined ? {} : { stack }),
    ...(code === undefined ? {} : { code }),
    ...(detailCode === undefined ? {} : { detailCode }),
  };
}

/** Read + parse the worker spec file, or return a `bad-spec` error message. */
function readSpec(specPath: string): ToolCommandWorkerSpec | DispatchWorkerMessage {
  try {
    return JSON.parse(readFileSync(specPath, 'utf8')) as ToolCommandWorkerSpec;
  } catch (error) {
    return errorMessage(
      `tool command worker: unreadable spec at '${specPath}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      'bad-spec',
    );
  }
}

/**
 * Resolve the dispatched tool from the re-bootstrapped scope, run the deep config
 * pass, then run its command handler against the worker-side context shim, and
 * build the result. Throws on a handler error (caught by
 * {@link runToolCommandWorker}); returns an `error` message for the structured
 * pre-handler failures (config-invalid; tool / command-not-found are thrown with
 * a failureClass tag).
 *
 * `currentScope()` here is the FULL per-run scope the CLI bootstrap built for the
 * `__tool-command-worker` subcommand (project/config/registries/contributeScope),
 * so the handler reads `cli.scope.toolConfig`/`cli.scope.<subscope>`/checks
 * worker-LOCAL. Datastore access is host-RPC-only: the ambient thunk is denied
 * (ADR-0145); privileged effects cross to the host via the RPC shim.
 */
async function runLoadedCommand(spec: ToolCommandWorkerSpec): Promise<DispatchWorkerMessage> {
  const tool = resolveTool(spec);

  // ADR-0054 M4-F hook mode: when the spec names a lifecycle HOOK (not a command),
  // run that hook worker-side and return its plain-data result. This is how the
  // host gathers an external tool's `collectReportData` / `sessionReplay` without
  // executing the untrusted runtime in the kernel process.
  if (spec.hook !== undefined) {
    return await runLoadedHook(tool, spec);
  }

  if (spec.commandName === undefined) {
    return errorMessage(
      `tool command worker: spec for tool '${spec.toolId}' names neither a command nor a hook`,
      'bad-spec',
    );
  }
  const commandSpec = findCommandSpec(tool, spec.commandName);

  // ADR-0054 M4-E DEEP config pass: run the tool's REAL Zod against its config
  // namespace IN THE WORKER (the host validated only the coarse manifest shape
  // pre-fork). A failure crosses IPC as `config-invalid` — never a host crash —
  // and the supervisor maps it to the SAME typed config error the host coarse
  // pass uses. Runs BEFORE building the context: a config failure must
  // short-circuit before any handler effect.
  const configFailure = runDeepConfigPass(tool, spec.config);
  if (configFailure !== undefined) return errorMessage(configFailure, 'config-invalid');

  // ADR-0054 M4-F: run the dispatched tool's `initialize()` worker-side before the
  // handler (the host no longer runs an external owning tool's initialize). A
  // throw becomes a structured `tool-handler-throw` via the outer catch.
  await runWorkerInitialize(tool);

  // Drive the DISPATCHED tool's capability domains here, worker-side, with the
  // SAME host-seeded resolution the in-process path uses. The worker bootstraps
  // the host `__tool-command-worker` subcommand (owned by NO tool), so the
  // pre-action `owning-capability-load` phase drove nothing for the dispatched
  // tool — leaving the tool's own lazy loader (e.g. fitness `ensureChecksLoaded`)
  // to fall through to auto-discovery under a divergent anchor, which resolved a
  // DIFFERENT pack set than the host's seeded load (the bundled≡installed check-
  // surface divergence). Loading here, keyed on the canonical project root, makes
  // the host driver the single authoritative capability loader on both paths;
  // the tool's lazy loader then observes the domain already loaded and no-ops.
  const workerProjectDir =
    currentScope()?.projectContext?.projectRoot ??
    (typeof spec.opts.cwd === 'string' ? spec.opts.cwd : '');
  await loadOwningToolCapabilities({
    owningTool: tool,
    projectDir: workerProjectDir,
    pluginsConfig: currentScope()?.configDocument?.plugins ?? {},
  });

  // The host-RPC upcall client over the live IPC channel (M4-C). `process` is the
  // duplex: requests post via `process.send`; replies arrive on
  // `process.on('message')`. Disposed in the finally so the listener is removed.
  const rpcClient = createWorkerRpcClient(process);
  // The handler runs against the bootstrapped scope (worker-local reads) but with
  // the WORKER context shim (FRR records + RPC upcalls for privileged effects).
  const scope = currentScope();
  if (scope === undefined) {
    return errorMessage(
      'tool command worker: no scope is entered (bootstrap did not run before the worker handler)',
      'runtime-load-failed',
    );
  }
  try {
    const acc: ResultAccumulator = {};
    const maxCapturedOutputBytes = getWorkerLimits().maxCapturedOutputBytes;
    // The completion envelope only crosses IPC (and is size-checked) for the live
    // view; --json / non-TTY runs never read it, so they must not pay for it.
    const captureCompletionEnvelope = spec.presentationMode === 'adapter-live';
    const adapterProgress =
      spec.presentationMode === 'adapter-live'
        ? {
            mode: 'live' as const,
            suppressHumanRender: true,
            emit: (event: ExternalAdapterProgressEvent) => {
              send({
                kind: 'progress',
                event: { kind: 'adapter-progress', event },
              });
            },
          }
        : undefined;
    const ctx = buildWorkerContext({
      scope,
      timing: createRunTimer(),
      acc,
      rpcClient,
      maxCapturedOutputBytes,
      ...(adapterProgress === undefined ? {} : { adapterProgress }),
    });

    // Run the handler. A `process.exit` / crash / hang here is contained by the
    // supervisor (premature-exit / timeout → structured parent failure); a throw
    // propagates to runToolCommandWorker's catch and becomes a structured error.
    // The handler's RETURN serves two roles: (1) for `command-result` /
    // `signal-envelope` it IS the output payload (routed by `dispatchOutput`
    // host-side); (2) it may carry a `session` leg (ToolRunCompletion) the host
    // persists after the worker resolves (host-owned-run-timing). Capture it once.
    const returned = (await commandSpec.handler(
      { ...spec.opts, _args: spec.positionals },
      ctx,
    )) as MaybeCompletion | void;
    if (captureCompletionEnvelope && returned?.envelope !== undefined) {
      assertCapturedOutputFits('completionEnvelope', returned.envelope, maxCapturedOutputBytes);
    }
    assertReturnValuedHandlerResult(commandSpec, acc, returned);
    return {
      kind: 'result',
      value: toResult(
        commandSpec.output,
        acc,
        returned?.session,
        returned,
        captureCompletionEnvelope,
      ),
    };
  } finally {
    rpcClient.dispose();
  }
}

/**
 * ADR-0054 M4-F: run a dispatched tool's LIFECYCLE HOOK worker-side and return its
 * plain-data result in `hookResult`. This is how the host gathers an EXTERNAL
 * tool's `collectReportData` / `sessionReplay` data WITHOUT executing the
 * untrusted runtime in the kernel process. The hook runs against the worker's own
 * re-bootstrapped scope (`currentScope()`), exactly the contract the in-host path
 * gives a bundled tool — just inside the isolation boundary. The host owns the
 * merge/render/replay-emit (privileged effect). A throw propagates to
 * {@link runToolCommandWorker}'s catch → structured failure; the host survives.
 *
 * The hook's runtime is resolved from the re-bootstrapped registry (the worker
 * `initialize()` does NOT run for a hook-mode dispatch — hooks read data; an
 * external tool that needs `initialize` for its report/replay should run it in
 * the hook body, which is OUT of M4-F's first-party scope).
 */
async function runLoadedHook(
  tool: Tool,
  spec: ToolCommandWorkerSpec,
): Promise<DispatchWorkerMessage> {
  const scope = currentScope();
  if (scope === undefined) {
    return errorMessage(
      'tool command worker: no scope is entered for the hook run (bootstrap did not run)',
      'runtime-load-failed',
    );
  }
  const hooks = resolveToolHooks(tool);
  // `collectReportData(scope)` takes the tool-facing ToolScope view; the worker
  // RunScope IS a ToolScope (it extends it), so pass it directly — it returns a
  // plain-data Record<string, unknown>. `sessionReplay` rebuilds the
  // ToolSessionReplay from the stored row (`hookArg` is the serialized
  // ToolSessionRecord the host read from the datastore).
  const hookResult: unknown =
    spec.hook === 'collectReportData'
      ? await hooks.collectReportData?.(scope)
      : hooks.sessionReplay?.replaySession(spec.hookArg as ToolSessionRecord);
  return {
    kind: 'result',
    // `output` is required on the result; the host never replays output for a
    // hook-mode dispatch (it reads `hookResult`), so a benign default suffices.
    value: {
      output: 'command-result',
      ...(hookResult === undefined ? {} : { hookResult }),
    },
  };
}

/**
 * The testable core: produce the {@link DispatchWorkerMessage} the worker would
 * post, without touching `process.send`. Never throws — every failure becomes a
 * structured `error` message (the supervisor rejects on it). Must run inside an
 * entered scope (the bootstrap enters it for the real subcommand; unit tests wrap
 * it in `runWithScope`).
 */
export async function runToolCommandWorker(specPath: string): Promise<DispatchWorkerMessage> {
  const spec = readSpec(specPath);
  if ('kind' in spec) return spec; // bad-spec error message
  try {
    return stampWorkerDiagnostics(await runLoadedCommand(spec));
  } catch (error) {
    return stampWorkerDiagnostics(
      errorMessage(
        error instanceof Error ? error.message : String(error),
        classifyThrow(error),
        error instanceof Error ? error.stack : undefined,
        // Carry the canonical exit-class code for a typed ToolError so the host
        // rebuilds the right subclass (NotFound → 3, Network → 4, …) instead of the
        // SystemError → exit 1 fallthrough. ConfigurationError ALSO rides
        // `failureClass: 'config-invalid'` above; this carry generalizes the rest.
        error instanceof ToolError ? canonicalToolErrorCode(error) : undefined,
        // Keep the stable subcode separate from the canonical class. In particular,
        // ADR-0145's direct-datastore denial must remain machine-identifiable after
        // the worker boundary.
        error instanceof ToolError ? error.code : undefined,
      ),
    );
  }
}

/**
 * Attach the worker run's diagnostics snapshot to the terminal result message so
 * the host can fold it into its own bus (observability parity, this ADR): a
 * worker-side capability decision (a domain that routed 0-of-N packs, a denied
 * pack, a foreign-core skip) reaches the operator's `--json` diagnostics instead
 * of dying with the worker. The error IPC arm carries its own structured
 * message/stack; result diagnostics are the observability-critical path.
 */
function stampWorkerDiagnostics(msg: DispatchWorkerMessage): DispatchWorkerMessage {
  if (msg.kind !== 'result') return msg;
  const diagnostics = currentScope()?.diagnostics.snapshot();
  if (diagnostics === undefined) return msg;
  return { ...msg, value: { ...msg.value, diagnostics } };
}

/**
 * Run one external tool command headless in this worker and post the slim
 * {@link ToolCommandResult} (or a structured `error`) over IPC. Never throws to
 * the caller — every failure becomes an `error` IPC message so the supervisor
 * rejects cleanly. This is the host CommandSpec handler's body.
 */
export async function executeToolCommandWorker(specPath: string): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    await sendTerminal(await runToolCommandWorker(specPath));
  } finally {
    stopHeartbeat();
  }
}

/**
 * `__tool-command-worker <specPath>` — the [internal] host subcommand the
 * dispatch supervisor forks. Mirrors `graphRunWorkerCommandSpec`: `raw-stream`
 * (it owns its own IPC output surface), `scope: 'project'` (the full bootstrap
 * runs first), `visibility: 'internal'`. The supervisor passes `--cwd` so the
 * bootstrap targets the right project. The handler ignores the host `ctx` it is
 * given (the worker builds its OWN context shim over the bootstrapped scope) and
 * posts the result over the IPC channel.
 */
export const toolCommandWorkerCommandSpec: CommandSpec<unknown, CliCommandsContext> = defineCommand<
  unknown,
  CliCommandsContext
>({
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/bootstrap/tool-command-worker-entry.ts',
    declaration: 'toolCommandWorkerCommandSpec',
  },
  name: '__tool-command-worker',
  visibility: 'internal',
  description:
    '[internal] Run one external tool command headless in a forked worker and stream the result over IPC (forked by the ADR-0054 dispatch supervisor)',
  // The supervisor passes the resolved project selection back through bootstrap.
  commonFlags: ['cwd'],
  options: [
    {
      flag: '--config',
      value: '<path>',
      description: 'Resolved project config inherited from the parent run',
    },
  ],
  args: [
    {
      name: 'specPath',
      description: 'Path to the JSON tool-command worker spec file',
    },
  ],
  scope: 'project',
  noInit: true,
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeToolCommandWorker(specPath);
  },
});
