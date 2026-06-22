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
 * host-RPC seams (datastore / egress / SARIF / baselines / toolState / hostPlanes
 * / report-open / exit-code re-affirm) UPCALL the host over the rpc-reply channel
 * (the host performs the privileged effect — datastore/network/FS/exit stay
 * host-owned). Only the live-view seams fail loud (`unsupported-seam`).
 *
 * A handler that calls `process.exit`, throws, crashes the native layer, or spins
 * the event loop is contained: the supervisor turns a premature child exit /
 * timeout / `error` message into a structured parent-side failure, and the host
 * process survives.
 */

import { readFileSync } from 'node:fs';

import {
  createRunTimer,
  currentScope,
  defineCommand,
  resolveToolHooks,
  type CommandSpec,
  type ToolCliContext,
  type Tool,
  type ToolSessionContribution,
  type WorkerMessage,
} from '@opensip-cli/core';

import { type CliCommandsContext } from '../commands/shared.js';

import {
  buildWorkerContext,
  UnsupportedSeamError,
  type ResultAccumulator,
} from './tool-command-worker-context.js';
import { createWorkerRpcClient } from './tool-command-worker-rpc.js';

import type {
  HostRpcRequest,
  ToolCommandFailureClass,
  ToolCommandResult,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';

/**
 * The worker's IPC message type binding: host-RPC requests stream on the
 * `progress` arm; the final {@link ToolCommandResult} settles `result`.
 */
type DispatchWorkerMessage = WorkerMessage<HostRpcRequest, ToolCommandResult>;

/** Post one IPC message to the parent (no-op when not forked — e.g. a unit call). */
function send(msg: DispatchWorkerMessage): void {
  process.send?.(msg);
}

/**
 * Resolve the dispatched tool from the re-bootstrapped registry. The bootstrap
 * already imported + registered it (the isolation import happened in this worker
 * during preAction). Match by the registry's human key first, then by stable id /
 * human name — symmetric to the host provenance/dispatch matchers.
 *
 * @throws {Error & {failureClass}} `runtime-load-failed` when the tool is not in
 *   the worker's registry (the bootstrap did not admit it — e.g. a trust-policy
 *   or discovery miss). Surfaces as a structured IPC error; the host survives.
 */
function resolveTool(spec: ToolCommandWorkerSpec): Tool {
  const tools = currentScope()?.tools;
  const tool =
    tools?.get(spec.toolId) ??
    tools?.list().find((t) => t.metadata.id === spec.toolId || t.metadata.name === spec.toolId);
  if (tool === undefined) {
    const err = new Error(
      `tool command worker: tool '${spec.toolId}' is not registered in the worker scope ` +
        '(the bootstrap did not discover/admit it — check provenance/trust policy)',
    );
    (err as Error & { failureClass: ToolCommandFailureClass }).failureClass = 'runtime-load-failed';
    throw err;
  }
  return tool;
}

/** Resolve the command spec the worker should run, or throw `command-not-found`. */
function findCommandSpec(tool: Tool, commandName: string): CommandSpec<unknown, ToolCliContext> {
  const spec = tool.commandSpecs?.find((s) => s.name === commandName);
  if (spec === undefined) {
    const err = new Error(
      `tool command worker: tool '${tool.metadata.id}' has no command '${commandName}'`,
    );
    (err as Error & { failureClass: ToolCommandFailureClass }).failureClass = 'command-not-found';
    throw err;
  }
  return spec;
}

/** Build a structured `error` IPC message with a failure class (+ stack when present). */
function errorMessage(
  message: string,
  failureClass: ToolCommandFailureClass,
  stack?: string,
): DispatchWorkerMessage {
  return {
    kind: 'error',
    message,
    failureClass,
    ...(stack === undefined ? {} : { stack }),
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

/** The completion shape a run-producing handler returns (the session leg the host persists). */
interface MaybeCompletion {
  readonly session?: ToolSessionContribution;
}

/**
 * The output modes whose PAYLOAD is the handler's RETURN value (routed by the
 * in-process `dispatchOutput`): `command-result` (a `CommandResult`) and
 * `signal-envelope` (a `SignalEnvelope`). For these, the worker must carry the
 * return back UNROUTED in `returned` so the supervisor replays it through the SAME
 * `dispatchOutput`. `raw-stream` / `live-view` produce no routable return payload.
 */
function isReturnValuedOutput(output: ToolCommandResult['output']): boolean {
  return output === 'command-result' || output === 'signal-envelope';
}

/** Drain the accumulator + the handler's return into a serializable result. */
function toResult(
  output: ToolCommandResult['output'],
  acc: ResultAccumulator,
  session: ToolSessionContribution | undefined,
  returned: unknown,
): ToolCommandResult {
  return {
    output,
    ...(acc.render === undefined ? {} : { render: acc.render }),
    ...(acc.envelope === undefined ? {} : { envelope: acc.envelope }),
    ...(acc.json === undefined ? {} : { json: acc.json }),
    ...(acc.raw === undefined ? {} : { raw: acc.raw }),
    ...(acc.error === undefined ? {} : { error: acc.error }),
    ...(acc.exitCode === undefined ? {} : { exitCode: acc.exitCode }),
    ...(session === undefined ? {} : { session }),
    // Carry the handler's return for the return-valued modes so the supervisor
    // routes it via the same `dispatchOutput` the in-process path uses (parity).
    ...(returned === undefined || !isReturnValuedOutput(output) ? {} : { returned }),
  };
}

/** Map a thrown error to its structured failure class for the IPC `error` message. */
function classifyThrow(error: unknown): ToolCommandFailureClass {
  if (error instanceof UnsupportedSeamError) return error.failureClass;
  return (error as { failureClass?: ToolCommandFailureClass }).failureClass ?? 'tool-handler-throw';
}

/** A Zod-ish schema: the worker checks for `safeParse` structurally (no zod import). */
interface SafeParseable {
  readonly safeParse: (value: unknown) => {
    readonly success: boolean;
    readonly error?: {
      readonly issues?: readonly { path?: readonly unknown[]; message: string }[];
    };
  };
}

/** Structural guard: the loaded tool's config schema exposes a `safeParse` method. */
function isSafeParseable(value: unknown): value is SafeParseable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * The ADR-0054 M4-E DEEP config pass: run the dispatched tool's OWN Zod
 * `ToolConfigDeclaration` against its coarse-validated config namespace block —
 * the semantic, authoritative validation the host (which must not import the
 * tool's Zod) could not perform pre-fork. Legitimate inside the isolation
 * boundary: the runtime is already loaded HERE, in the worker.
 *
 * Returns `undefined` on success (or when there is nothing to validate); returns
 * a structured `config-invalid` {@link DispatchWorkerMessage} on a Zod failure —
 * the worker does NOT throw/crash; the supervisor maps it to the SAME typed
 * config error + exit code the host coarse pass uses (single config-error
 * contract).
 */
function runDeepConfigPass(tool: Tool, config: unknown): DispatchWorkerMessage | undefined {
  // No config block in the document for this tool's namespace → nothing to
  // deep-validate (the host coarse pass already accepted its absence).
  if (config === undefined) return undefined;
  const declaration = resolveToolHooks(tool).config;
  // No Zod declaration on the runtime → defer to the coarse pass's verdict (the
  // host already accepted the block as an opaque object); nothing deeper to run.
  if (declaration === undefined || !isSafeParseable(declaration.schema)) return undefined;

  const result = declaration.schema.safeParse(config);
  if (result.success) return undefined;

  const summary = (result.error?.issues ?? [])
    .map((issue) => {
      const path =
        issue.path !== undefined && issue.path.length > 0
          ? issue.path.join('.')
          : declaration.namespace;
      return `${declaration.namespace}.${path}: ${issue.message}`;
    })
    .join('; ');
  return errorMessage(
    `Invalid configuration for '${tool.metadata.name ?? tool.metadata.id}': ${
      summary.length > 0 ? summary : 'config did not satisfy the tool schema'
    }`,
    'config-invalid',
  );
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
 * worker-LOCAL while datastore/egress cross to the host via the RPC shim.
 */
async function runLoadedCommand(spec: ToolCommandWorkerSpec): Promise<DispatchWorkerMessage> {
  const tool = resolveTool(spec);
  const commandSpec = findCommandSpec(tool, spec.commandName);

  // ADR-0054 M4-E DEEP config pass: run the tool's REAL Zod against its config
  // namespace IN THE WORKER (the host validated only the coarse manifest shape
  // pre-fork). A failure crosses IPC as `config-invalid` — never a host crash —
  // and the supervisor maps it to the SAME typed config error the host coarse
  // pass uses. Runs BEFORE building the context: a config failure must
  // short-circuit before any handler effect.
  const configFailure = runDeepConfigPass(tool, spec.config);
  if (configFailure !== undefined) return configFailure;

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
    const ctx = buildWorkerContext(scope, createRunTimer(), acc, rpcClient);

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
    return {
      kind: 'result',
      value: toResult(commandSpec.output, acc, returned?.session, returned),
    };
  } finally {
    // @fitness-ignore-next-line detached-promises -- WorkerRpcClient.dispose() returns void (removes the reply listener + clears the pending map, synchronous); the name-based heuristic misfires inside this async fn.
    rpcClient.dispose();
  }
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
    return await runLoadedCommand(spec);
  } catch (error) {
    return errorMessage(
      error instanceof Error ? error.message : String(error),
      classifyThrow(error),
      error instanceof Error ? error.stack : undefined,
    );
  }
}

/**
 * Run one external tool command headless in this worker and post the slim
 * {@link ToolCommandResult} (or a structured `error`) over IPC. Never throws to
 * the caller — every failure becomes an `error` IPC message so the supervisor
 * rejects cleanly. This is the host CommandSpec handler's body.
 */
export async function executeToolCommandWorker(specPath: string): Promise<void> {
  // @fitness-ignore-next-line detached-promises -- the promise IS awaited; `send(...)` is a synchronous void IPC post of the already-resolved value. The name-based heuristic misfires on `send(await ...)`.
  send(await runToolCommandWorker(specPath));
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
  name: '__tool-command-worker',
  visibility: 'internal',
  description:
    '[internal] Run one external tool command headless in a forked worker and stream the result over IPC (forked by the ADR-0054 dispatch supervisor)',
  // The supervisor passes `--cwd`; bootstrap uses it to resolve the project.
  commonFlags: ['cwd'],
  args: [{ name: 'specPath', description: 'Path to the JSON tool-command worker spec file' }],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeToolCommandWorker(specPath);
  },
});
