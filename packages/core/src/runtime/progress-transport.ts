/**
 * ProgressTransport — the seam that decouples *where a tool's work runs* from
 * *how its progress reaches the renderer* (ADR-0016).
 *
 * Two implementations:
 *   - in-process (this directory) — a plain in-memory fan-out, for tools whose
 *     execution already yields to the event loop (fit, sim).
 *   - subprocess (added with the graph subprocess work) — forks a child and
 *     relays IPC messages, for tools whose work is a synchronous CPU blast that
 *     would otherwise starve the render thread (graph).
 *
 * The interface is generic over the event and result types so core — the kernel,
 * which imports nothing from the workspace — never names cli-ui's concrete
 * `ProgressEvent`. Callers bind `TEvent` to `ProgressEvent` at the tool layer.
 */

import type { RunCorrelation } from '../lib/run-correlation.js';

/** A live run in progress: subscribe for events, await the final result. */
export interface ProgressRun<TEvent, TResult> {
  /**
   * Register a listener for streamed events. Events emitted before the first
   * listener attaches are buffered and flushed on subscription, so a fast job
   * cannot race the renderer's mount and drop early events.
   */
  readonly onProgress: (listener: (event: TEvent) => void) => void;
  /** Resolves with the tool's final result; rejects if the run fails. */
  readonly result: Promise<TResult>;
}

/**
 * In-process job: a closure that emits events as it runs and resolves a result.
 * The subprocess transport accepts a serializable descriptor instead (it cannot
 * ship a closure across the process boundary); both satisfy
 * {@link ProgressTransport} via distinct `run` overloads at their call sites.
 */
export type ProgressJob<TEvent, TResult> = (emit: (event: TEvent) => void) => Promise<TResult>;

/** Runs a job and streams its progress to subscribers. */
export interface ProgressTransport {
  run<TEvent, TResult>(job: ProgressJob<TEvent, TResult>): ProgressRun<TEvent, TResult>;
}

/**
 * A description of off-main-PROCESS work (ADR-0028). The off-thread variant runs
 * the engine in a forked child that re-bootstraps the full CLI scope (language +
 * tool registries, project, config) — a worker *thread* can't, because that
 * bootstrap is CLI-owned and a partial registry would diverge a polyglot run's
 * results. So the descriptor names the node module to fork (the CLI entry) + argv
 * (a worker subcommand + a temp spec path). No closure and no live handle (e.g.
 * the datastore) crosses the boundary; persistence + egress stay on the main
 * process after the run returns.
 */
export interface SubprocessJobDescriptor {
  /** Node module to fork — the CLI entry (`process.argv[1]`). */
  readonly command: string;
  /** Argv for the fork — typically `[<worker-subcommand>, <specPath>]`. */
  readonly argv: readonly string[];
  /** Extra environment for the child (merged over the parent's). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The parent run's correlation bag, sans `runId` (subprocess-correlation
   * telemetry spec, Phase 2). OPTIONAL for wire-compat: a mismatched
   * parent↔worker build during a partial upgrade still forks (spec GAP a).
   *
   * `runId` is deliberately excluded — per B1 it travels via `OPENSIP_RUN_ID`
   * env ONLY, injected from the parent scope by `createSubprocessProgressRun`
   * (the fork path has no temp-file spec to carry it, unlike the spawn path's
   * `ShardWorkerSpec.correlation`). The remaining fields
   * (`tool`/`parentCommand`/`traceId`/`workerKind`/…) are folded into the child
   * env by the transport so the forked live-engine worker can attribute its log
   * lines to the parent run. Symmetric to `ShardWorkerSpec.correlation`.
   */
  readonly correlation?: Omit<RunCorrelation, 'runId'>;
}

/**
 * The child→parent IPC message protocol. The forked worker posts these via
 * `process.send`; the subprocess {@link ProgressRun} maps `progress` to
 * subscribers, resolves on `result`, and rejects on `error`. One source of truth
 * for both ends.
 */
export type WorkerMessage<TEvent, TResult> =
  | { readonly kind: 'progress'; readonly event: TEvent }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'result'; readonly value: TResult }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly stack?: string;
      /**
       * The forked worker's correlation bag, sans `runId` (subprocess-correlation
       * telemetry spec, Phase 2 step 4). Lets the parent log a structured
       * `cli.subprocess.failed` attributing the IPC failure to the right worker.
       * Optional for wire-compat (an old worker omits it).
       */
      readonly correlation?: Omit<RunCorrelation, 'runId'>;
      /**
       * The machine-filterable failure taxonomy for the worker error. Typed as a
       * plain `string` at this core IPC layer — the concrete `FailureClass` union
       * is owned by `@opensip-cli/graph` and core cannot import upward (layering).
       * The parent maps an absent value to `'ipc_error'` (and a premature exit to
       * `'exit_nonzero'`) when it logs `cli.subprocess.failed`.
       */
      readonly failureClass?: string;
      /**
       * The canonical exit-class `ToolErrorCode` (`canonicalToolErrorCode`) when
       * the worker error originated as a typed `ToolError`. Carried across the IPC
       * boundary — which flattens the prototype chain — so the parent supervisor
       * can rebuild the right `ToolError` subclass (`toolErrorFromCanonicalCode`)
       * and preserve the frozen exit code instead of collapsing every worker-thrown
       * typed error to `SystemError` (exit 1). Optional: absent for an untyped
       * throw or an older worker build.
       */
      readonly code?: string;
    };
