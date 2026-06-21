/**
 * tool-command-dispatch-types — the serializable wire contract for the
 * out-of-process external-tool command dispatch plane (ADR-0054, increments
 * M4-B / M4-C).
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
 * Two transport strategies cross this boundary (ADR-0054 M4-C):
 *   - final-result-return (FRR): the worker accumulates the value and returns it
 *     ONCE in {@link ToolCommandResult} (`render` / `emitJson` / `emitEnvelope`
 *     / `emitRaw` / `emitError` / `setExitCode`); the host replays it after the
 *     worker resolves.
 *   - host-RPC-request (RPC): a streamed upcall ({@link HostRpcRequest}) — the
 *     worker BLOCKS on a reply ({@link RpcReply}) because the effect touches the
 *     datastore / network / filesystem / process exit, which only the host may
 *     do. The host performs the privileged effect through the REAL host
 *     `ToolCliContext` and replies. This is the M4-C addition over the M4-D FRR
 *     slice: `deliverSignals` / `writeSarif` / the four baseline seams /
 *     `toolState.*` / `hostPlanes.*` / `maybeOpenReport` / `getExitCode` now
 *     upcall instead of failing loud.
 *
 * Live-view seams (`registerLiveView` / `renderLive`) stay host-side-only and
 * still fail loud in the worker — Ink/TTY rendering cannot leave the host
 * (ADR-0054 M4-C mapping table; documented as a later increment).
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
 *   - `unsupported-seam`     — the handler called a seam the worker cannot
 *                              marshal (the live-view seams; Ink/TTY rendering
 *                              cannot leave the host). The host-RPC seams are no
 *                              longer in this class — they upcall (M4-C).
 *   - `host-rpc-failed`      — a host-RPC upcall faulted host-side (the error
 *                              crossed back as a structured {@link RpcReply}).
 *   - `command-not-found`    — `commandName` did not match any `commandSpecs`.
 *   - `runtime-load-failed`  — `importToolRuntime` failed in the worker.
 *   - `bad-spec`             — the spec file was missing or unparseable.
 */
export type ToolCommandFailureClass =
  | 'tool-handler-throw'
  | 'unsupported-seam'
  | 'host-rpc-failed'
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

// ───────────────────────────────────────────────────────────────────────────
// Host-RPC upcall protocol (ADR-0054 M4-C)
//
// A streamed upcall: the worker sends ONE {@link HostRpcRequest} (carried over
// the transport's `progress` arm, `WorkerMessage<HostRpcRequest, ToolCommandResult>`)
// and BLOCKS until the matching {@link RpcReply} arrives (parent → child
// `child.send`). Every request carries a monotonic `rpcId`; the host replies
// with the same `rpcId`. The HOST performs the privileged effect through the
// REAL `ToolCliContext` seam and returns the value (or a structured error) — the
// host remains the only process that touches the datastore / network / FS /
// process exit. Both shapes are plain-data (structured-clone safe).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The three datastore-backed host planes reachable via `ctx.hostPlanes.*`. A
 * generic `hostPlane` upcall names the plane + method + serializable args so the
 * host can dispatch to the real plane impl without a dedicated request variant
 * per method (the planes carry several opaque-record methods each; one generic
 * variant keeps this contract small and forward-compatible).
 */
export type HostPlaneKind = 'governance' | 'audit' | 'entitlements';

/** The serializable subset of `deliverSignals`'s opts (no functions/handles). */
export interface DeliverSignalsOpts {
  readonly cwd: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly runFailed?: boolean;
}

/**
 * One host-RPC upcall, WITHOUT the correlation id — the shape the worker shim
 * builds and the host switch consumes. Discriminated by `seam`; each variant's
 * payload mirrors the arguments of the matching `ToolCliContext` seam (the
 * envelope/opts/payloads are all plain-data on those seams already).
 *
 * Kept as a standalone union (rather than `Omit<HostRpcRequest, 'rpcId'>`)
 * because `Omit` does not distribute over the `{ rpcId } & union` intersection
 * — it would collapse to only the common keys.
 */
export type HostRpcCall =
  | {
      readonly seam: 'deliverSignals';
      readonly envelope: unknown;
      readonly opts: DeliverSignalsOpts;
    }
  | { readonly seam: 'writeSarif'; readonly envelope: unknown; readonly path: string }
  | { readonly seam: 'saveBaseline'; readonly tool: string; readonly envelope: unknown }
  | { readonly seam: 'compareBaseline'; readonly tool: string; readonly envelope: unknown }
  | { readonly seam: 'exportBaselineSarif'; readonly tool: string; readonly path: string }
  | { readonly seam: 'exportBaselineFingerprints'; readonly tool: string; readonly path: string }
  | { readonly seam: 'toolState.get'; readonly tool: string; readonly key: string }
  | {
      readonly seam: 'toolState.put';
      readonly tool: string;
      readonly key: string;
      readonly payload: unknown;
    }
  | { readonly seam: 'toolState.delete'; readonly tool: string; readonly key: string }
  | { readonly seam: 'toolState.list'; readonly tool: string }
  | {
      readonly seam: 'maybeOpenReport';
      readonly opts: { readonly openRequested: boolean; readonly jsonOutput: boolean };
    }
  | { readonly seam: 'getExitCode' }
  | {
      readonly seam: 'hostPlane';
      readonly plane: HostPlaneKind;
      readonly method: string;
      readonly args: readonly unknown[];
    };

/**
 * One host-RPC upcall as it crosses the wire: a {@link HostRpcCall} stamped with
 * the monotonic `rpcId` that correlates the matching {@link RpcReply}.
 */
export type HostRpcRequest = HostRpcCall & { readonly rpcId: number };

/**
 * The host's reply to one {@link HostRpcRequest} (parent → child). Discriminated
 * by `ok`: a resolved value crosses as `{ ok: true, value }`; a host-side fault
 * crosses as `{ ok: false, error }` (a STRUCTURED rejection the worker shim
 * re-throws so the handler sees it as a normal thrown error — never a host
 * crash, never a silent no-op).
 */
export type RpcReply =
  | {
      readonly kind: 'rpc-reply';
      readonly rpcId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: 'rpc-reply';
      readonly rpcId: number;
      readonly ok: false;
      readonly error: { readonly message: string; readonly code?: string; readonly stack?: string };
    };
