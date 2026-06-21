/**
 * tool-command-worker-entry — the WORKER side of the out-of-process external
 * tool command dispatch plane (ADR-0054, increment M4-D vertical slice).
 *
 * This module is forked as a standalone node entry by the host supervisor
 * (`fork(<this module's built .js>, [specPath])`), exactly as the graph live
 * runner forks `graph-run-worker` and the transport tests fork the
 * `progress-worker.mjs` fixture. It speaks the {@link WorkerMessage} IPC
 * protocol (`progress | result | error`) back to the parent over `process.send`.
 *
 * The isolation move (ADR-0054's core decision): the untrusted EXTERNAL tool
 * runtime is dynamic-imported HERE, in the worker process — never in the host.
 * A handler that calls `process.exit`, throws, crashes the native layer, or
 * spins the event loop is contained: the supervisor turns a premature child
 * exit / timeout / `error` message into a structured parent-side failure, and
 * the host process survives.
 *
 * The marshalled context subset for the slice is the final-result-return seams
 * (`render` / `emitJson` / `emitEnvelope` / `emitRaw` / `emitError`) plus
 * `setExitCode` (last-write-wins). Every other `ToolCliContext` seam (datastore
 * reads, cloud egress, SARIF write, baselines, toolState, hostPlanes, live
 * views) throws an `unsupported-seam` failure in the worker shim — it fails
 * loudly, never silently no-ops. Those become host-RPC upcalls in later
 * increments (ADR-0054 M4-C/M4-E/M4-F).
 */

import { readFileSync } from 'node:fs';

import {
  correlationFromEnv,
  createRunTimer,
  enterScope,
  RunScope,
  type CommandSpec,
  type RunTimer,
  type ToolCliContext,
  type Tool,
  type WorkerMessage,
} from '@opensip-cli/core';

import { hostRuntimeImportPolicyFor, importToolRuntime } from './admit-tool-package.js';

import type {
  ToolCommandFailureClass,
  ToolCommandResult,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';

/** The worker's IPC result type binding: no progress events in the slice (never[]). */
type DispatchWorkerMessage = WorkerMessage<never, ToolCommandResult>;

/** Post one IPC message to the parent (no-op when not forked — e.g. a unit call). */
function send(msg: DispatchWorkerMessage): void {
  process.send?.(msg);
}

/**
 * A loud, marked failure for a seam the worker shim does not marshal in this
 * slice. Carries the {@link ToolCommandFailureClass} so the supervisor can
 * triage; the worker catch turns it into an `error` IPC message.
 */
class UnsupportedSeamError extends Error {
  readonly failureClass: ToolCommandFailureClass = 'unsupported-seam';
  constructor(seam: string) {
    super(
      `tool command worker: seam '${seam}' is not marshalled in the ADR-0054 ` +
        'dispatch slice (host-RPC / live-view seams arrive in a later increment). ' +
        'The external command attempted a privileged effect the worker cannot perform.',
    );
    this.name = 'UnsupportedSeamError';
  }
}

/**
 * Build a host-RPC seam stub that fails loudly when an external handler calls a
 * seam not marshalled in this slice.
 *
 * @throws {UnsupportedSeamError} always — that is the point: an unmarshalled seam
 *   must surface as a structured failure, never a silent no-op.
 */
function unsupported(seam: string): (...args: unknown[]) => never {
  // @fitness-ignore-next-line throws-documentation -- the throw is documented on the enclosing `unsupported` factory's @throws above; this is the one-line closure it returns.
  return () => {
    throw new UnsupportedSeamError(seam);
  };
}

/**
 * The mutable accumulator the worker-side context shim records final-result
 * seam calls into. Drained into a {@link ToolCommandResult} after the handler
 * resolves.
 */
interface ResultAccumulator {
  render?: unknown;
  envelope?: unknown;
  json?: unknown;
  raw?: unknown;
  error?: ToolCommandResult['error'];
  exitCode?: number;
}

/**
 * Build the worker-side {@link ToolCliContext} shim. Final-result-return seams
 * record into `acc`; host-RPC and live-view seams throw an
 * {@link UnsupportedSeamError}. `scope` / `runSession` / `logger` are backed by
 * the worker's own minimal {@link RunScope} (entered before the handler runs).
 */
function buildWorkerContext(
  scope: RunScope,
  timing: RunTimer,
  acc: ResultAccumulator,
): ToolCliContext {
  return {
    scope,
    runSession: { timing },
    logger: scope.logger,
    // ── Final-result-return seams (marshalled) ────────────────────────────
    render: (result: unknown) => {
      acc.render = result;
      return Promise.resolve();
    },
    emitJson: (value: unknown) => {
      acc.json = value;
    },
    emitEnvelope: (envelope: unknown) => {
      acc.envelope = envelope;
    },
    emitRaw: (value: unknown) => {
      acc.raw = value;
    },
    emitError: (detail) => {
      acc.error = {
        message: detail.message,
        exitCode: detail.exitCode,
        ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
        ...(detail.code === undefined ? {} : { code: detail.code }),
      };
    },
    setExitCode: (code: number) => {
      acc.exitCode = code;
    },
    getExitCode: () => acc.exitCode,
    // ── Host-RPC seams (NOT in this slice — fail loud) ────────────────────
    deliverSignals: unsupported('deliverSignals'),
    writeSarif: unsupported('writeSarif'),
    saveBaseline: unsupported('saveBaseline'),
    compareBaseline: unsupported('compareBaseline'),
    exportBaselineSarif: unsupported('exportBaselineSarif'),
    exportBaselineFingerprints: unsupported('exportBaselineFingerprints'),
    maybeOpenReport: unsupported('maybeOpenReport'),
    toolState: {
      get: unsupported('toolState.get'),
      put: unsupported('toolState.put'),
      delete: unsupported('toolState.delete'),
      list: unsupported('toolState.list'),
    },
    // ── Live-view seams (host-only — fail loud) ───────────────────────────
    registerLiveView: unsupported('registerLiveView'),
    renderLive: unsupported('renderLive'),
  };
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

/**
 * Run one external tool command headless in this worker and post the slim
 * {@link ToolCommandResult} (or a structured `error`) over IPC. Never throws to
 * the caller — every failure becomes an `error` IPC message so the supervisor
 * rejects cleanly. This is the testable core of the worker entry.
 */
export async function executeToolCommandWorker(specPath: string): Promise<void> {
  send(await runToolCommandWorker(specPath));
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

/** Drain the accumulator into a serializable {@link ToolCommandResult}. */
function toResult(output: ToolCommandResult['output'], acc: ResultAccumulator): ToolCommandResult {
  return {
    output,
    ...(acc.render === undefined ? {} : { render: acc.render }),
    ...(acc.envelope === undefined ? {} : { envelope: acc.envelope }),
    ...(acc.json === undefined ? {} : { json: acc.json }),
    ...(acc.raw === undefined ? {} : { raw: acc.raw }),
    ...(acc.error === undefined ? {} : { error: acc.error }),
    ...(acc.exitCode === undefined ? {} : { exitCode: acc.exitCode }),
  };
}

/** Map a thrown error to its structured failure class for the IPC `error` message. */
function classifyThrow(error: unknown): ToolCommandFailureClass {
  if (error instanceof UnsupportedSeamError) return error.failureClass;
  return (error as { failureClass?: ToolCommandFailureClass }).failureClass ?? 'tool-handler-throw';
}

/**
 * Import the runtime, find + run the command, and build the result. Throws on a
 * handler error (caught by {@link runToolCommandWorker}); returns an `error`
 * message for the structured pre-handler failures (load / command-not-found is
 * thrown with a failureClass tag).
 */
async function runLoadedCommand(spec: ToolCommandWorkerSpec): Promise<DispatchWorkerMessage> {
  // THE ISOLATION MOVE: import the untrusted external runtime IN the worker.
  const load = await importToolRuntime(
    spec.toolPackageDir,
    hostRuntimeImportPolicyFor(spec.source),
  );
  if (!load.ok) {
    return errorMessage(
      `tool command worker: runtime load failed (${load.reason}${
        load.detail ? `: ${load.detail}` : ''
      })`,
      'runtime-load-failed',
    );
  }

  const commandSpec = findCommandSpec(load.tool, spec.commandName);

  // Minimal worker scope so `currentScope()`, `scope.logger`, and the run timer
  // resolve for the handler. The worker owns its own scope (it never ships a
  // live RunScope across IPC); host-owned timing stays host-side. The runId is
  // read via the governed correlation env reader (env-via-registry), inherited
  // from the parent through `OPENSIP_RUN_ID` so the worker's diagnostic log lines
  // attribute to the parent run.
  const scope = new RunScope({ runId: correlationFromEnv()?.runId ?? '' });
  // @fitness-ignore-next-line detached-promises -- enterScope returns void (synchronous AsyncLocalStorage enter); the name-based heuristic misfires inside this async fn.
  enterScope(scope);
  try {
    const acc: ResultAccumulator = {};
    const ctx = buildWorkerContext(scope, createRunTimer(), acc);

    // Run the handler. A `process.exit` / crash / hang here is contained by the
    // supervisor (premature-exit / timeout → structured parent failure); a throw
    // propagates to runToolCommandWorker's catch and becomes a structured error.
    await commandSpec.handler({ ...spec.opts, _args: spec.positionals }, ctx);
    return { kind: 'result', value: toResult(commandSpec.output, acc) };
  } finally {
    // Release per-run caches even in this short-lived fork (resilience hygiene).
    // @fitness-ignore-next-line detached-promises -- RunScope.dispose() returns void (synchronous cache teardown); the name-based heuristic misfires inside this async fn.
    scope.dispose();
  }
}

/**
 * The testable core: produce the {@link DispatchWorkerMessage} the worker would
 * post, without touching `process.send`. Never throws — every failure becomes a
 * structured `error` message (the supervisor rejects on it). Unit tests call
 * this directly; the fork entry sends its return value.
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

// Entry guard: when forked as a standalone node module the supervisor passes the
// spec path as argv[2] (`node <thisModule>.js <specPath>`). Mirrors the
// progress-worker fixture's top-level dispatch. Skipped when imported (unit
// tests call `executeToolCommandWorker` directly).
if (process.argv[1]?.includes('tool-command-worker-entry') === true) {
  // Top-level await at the fork entry: post the result/error over IPC, then the
  // process exits when settled. Mirrors the graph-worker fork entry.
  await executeToolCommandWorker(process.argv[2] ?? '');
}
