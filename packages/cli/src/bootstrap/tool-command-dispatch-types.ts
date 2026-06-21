/**
 * tool-command-dispatch-types — the serializable wire contract for the
 * out-of-process external-tool command dispatch plane (ADR-0054, increment
 * M4-B / M4-C vertical slice).
 *
 * These are the ONLY shapes that cross the host↔worker IPC boundary for a
 * dispatched external-tool command. Everything here MUST be structured-clone
 * safe (the transport forks with `serialization: 'advanced'`): plain data only,
 * no functions, no class instances, no live handles (datastore, registries,
 * Commander). The host marshals the spec → temp file → fork; the worker imports
 * the tool runtime, runs the handler against a worker-side `ToolCliContext`
 * shim, and posts back a {@link ToolCommandResult} (the final-result-return
 * subset of the seam→RPC mapping in ADR-0054's Build Plan).
 *
 * Scope of the slice (ADR-0054 M4-D): the marshalled context subset is the
 * final-result-return seams (`render` / `emitJson` / `emitEnvelope` / `emitRaw`
 * / `emitError`) plus `setExitCode` (last-write-wins). Host-RPC seams
 * (datastore, egress, SARIF write, baselines, toolState, hostPlanes) and the
 * live-view seams are explicitly NOT in this slice — a tool command that calls
 * them in the worker fails loudly (see the worker shim), it does not silently
 * no-op. Those land in later increments (M4-C RPC upcalls, M4-E/F).
 */

import type { CommandOutputMode, ToolSource } from '@opensip-cli/core';

/**
 * The request the host writes to a temp JSON spec file and forks the worker
 * with (`fork(workerEntry, [specPath])`). The worker re-resolves + re-imports
 * the tool runtime from `toolPackageDir` IN THE WORKER process — this is the
 * isolation move: untrusted external runtime code never loads in the host.
 *
 * `correlation` rides the child env (`OPENSIP_*`), not this spec, symmetric to
 * the graph fork path; it is intentionally absent here.
 */
export interface ToolCommandWorkerSpec {
  /** The tool's stable id (UUID) — for diagnostics + matching the imported runtime. */
  readonly toolId: string;
  /** The package directory the worker `importToolRuntime`s the runtime from. */
  readonly toolPackageDir: string;
  /**
   * The tool's provenance source. External only — bundled tools never fork
   * (they are the trusted computing base and stay in-process; ADR-0054 trust
   * tiers). The worker passes this to `hostRuntimeImportPolicyFor`.
   */
  readonly source: Exclude<ToolSource, 'bundled'>;
  /** Which of the tool's `commandSpecs` (by `name`) to run. */
  readonly commandName: string;
  /** The parsed Commander options for this invocation (serializable). */
  readonly opts: Record<string, unknown>;
  /** The trailing positionals (`_args`) for this invocation (serializable). */
  readonly positionals: readonly unknown[];
}

/**
 * A structured error category for a dispatched-command failure, so the host can
 * triage why a worker run failed (mirrors the transport's `failureClass`
 * taxonomy but for the COMMAND layer, not the fork layer).
 *
 *   - `tool-handler-throw`   — the handler threw inside the worker.
 *   - `unsupported-seam`     — the handler called a seam not marshalled in this
 *                              slice (datastore/egress/live-view); fail loud.
 *   - `command-not-found`    — `commandName` did not match any `commandSpecs`.
 *   - `runtime-load-failed`  — `importToolRuntime` failed in the worker.
 *   - `bad-spec`             — the spec file was missing or unparseable.
 */
export type ToolCommandFailureClass =
  | 'tool-handler-throw'
  | 'unsupported-seam'
  | 'command-not-found'
  | 'runtime-load-failed'
  | 'bad-spec';

/**
 * The final-result-return payload the worker posts back over IPC once the
 * command handler resolves. The host replays it through the REAL host
 * `ToolCliContext` seams so the output contract stays byte-identical to the
 * in-process path. Every field is optional: a handler that only set an exit code
 * (or returned void) yields a sparse result.
 *
 * `output` mirrors the command's declared {@link CommandOutputMode} so the host
 * knows which dispatch arm to drive.
 */
export interface ToolCommandResult {
  readonly output: CommandOutputMode;
  /** `ctx.render(...)` payload (CommandResult shape) — replayed via the host render seam. */
  readonly render?: unknown;
  /** `ctx.emitEnvelope(...)` payload (SignalEnvelope) — replayed via the host envelope seam. */
  readonly envelope?: unknown;
  /** `ctx.emitJson(...)` payload — replayed via the host JSON seam. */
  readonly json?: unknown;
  /** `ctx.emitRaw(...)` payload — replayed via the host raw seam. */
  readonly raw?: unknown;
  /** `ctx.emitError(...)` detail — replayed via the host error seam. */
  readonly error?: {
    readonly message: string;
    readonly exitCode: number;
    readonly suggestion?: string;
    readonly code?: string;
  };
  /** The last `ctx.setExitCode(...)` value (last-write-wins). */
  readonly exitCode?: number;
}
