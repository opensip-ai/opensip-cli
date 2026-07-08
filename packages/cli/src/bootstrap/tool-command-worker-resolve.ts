/**
 * tool-command-worker-resolve — the WORKER-side resolution + error-classification
 * helpers for the out-of-process tool-command dispatch plane (ADR-0054). Extracted
 * from `tool-command-worker-entry.ts` so the entry module keeps only the run
 * orchestration; this module owns "find the tool + command, run its initialize,
 * and classify a thrown error into its structured failure class".
 */

import {
  CapturedOutputTooLargeError,
  ConfigurationError,
  currentScope,
  IpcPayloadTooLargeError,
  resolveToolHooks,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

import { UnsupportedSeamError } from './tool-command-worker-context.js';

import type {
  ToolCommandFailureClass,
  ToolCommandWorkerSpec,
} from './tool-command-dispatch-types.js';

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
export function resolveTool(spec: ToolCommandWorkerSpec): Tool {
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
export function findCommandSpec(
  tool: Tool,
  commandName: string,
): CommandSpec<unknown, ToolCliContext> {
  const spec = tool.commandSpecs?.find(
    (s) => s.name === commandName || s.aliases?.includes(commandName) === true,
  );
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
 * ADR-0054 M4-F: run the dispatched tool's `initialize()` once, worker-side,
 * before its handler. The host no longer runs an EXTERNAL owning tool's
 * `initialize` (that would execute untrusted runtime in the kernel) — and the
 * worker bootstraps the host `__tool-command-worker` subcommand (owned by NO
 * tool), so the worker's own preflight never resolves the dispatched tool as the
 * "owning tool". Running it here is the only place an external tool's
 * `initialize` runs under worker dispatch. A throw propagates to the entry
 * module's catch → structured `tool-handler-throw`; the host survives (fail loud,
 * never a half-initialised silent run).
 */
export async function runWorkerInitialize(tool: Tool): Promise<void> {
  const initialize = resolveToolHooks(tool).initialize;
  if (initialize === undefined) return;
  await initialize();
}

/**
 * Map a thrown error to its structured failure class for the IPC `error` message.
 *
 * A thrown `ConfigurationError` maps to `'config-invalid'` so the supervisor's
 * `dispatchError` reconstructs a `ConfigurationError` (→ exit 2) — the SAME
 * contract the in-process bundled path and `doctor` honour. Without this, a
 * binary-not-found / no-project / baseline-missing config fault thrown in the
 * worker would flatten to the generic `'tool-handler-throw'` → `SystemError` →
 * exit 1, silently losing the frozen exit-2 contract over the fork boundary. The
 * non-config typed exit classes (NotFound → 3, Network → 4, …) ride the separate
 * `code` carry (`canonicalToolErrorCode`) — see `errorMessage`/`runToolCommandWorker`.
 */
export function classifyThrow(error: unknown): ToolCommandFailureClass {
  if (error instanceof UnsupportedSeamError) return error.failureClass;
  if (error instanceof CapturedOutputTooLargeError) return error.failureClass;
  if (error instanceof IpcPayloadTooLargeError) return error.failureClass;
  if (error instanceof ConfigurationError) return 'config-invalid';
  return (error as { failureClass?: ToolCommandFailureClass }).failureClass ?? 'tool-handler-throw';
}
