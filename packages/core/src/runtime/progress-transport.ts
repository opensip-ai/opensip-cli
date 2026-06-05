/**
 * ProgressTransport — the seam that decouples *where a tool's work runs* from
 * *how its progress reaches the renderer* (ADR-0015).
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
