/**
 * In-process ProgressTransport (ADR-0015) — runs the job in the current process
 * and fans its events out to subscribers. The common case: tools whose execution
 * already yields to the event loop (fit's async file I/O, sim's awaited
 * scenarios), so the render thread stays free to animate.
 *
 * Pre-subscribe events are buffered and flushed when the first listener attaches.
 * Ink mounts the renderer's `useEffect` subscription synchronously after
 * `render(...)`, but the job's first `emit` can still land first — buffering
 * guarantees no early event is dropped.
 */

import type { ProgressJob, ProgressRun, ProgressTransport } from './progress-transport.js';

export function createInProcessTransport(): ProgressTransport {
  return {
    run<TEvent, TResult>(job: ProgressJob<TEvent, TResult>): ProgressRun<TEvent, TResult> {
      let listener: ((event: TEvent) => void) | undefined;
      const buffer: TEvent[] = [];

      const emit = (event: TEvent): void => {
        if (listener) {
          listener(event);
        } else {
          buffer.push(event);
        }
      };

      // Start the job eagerly; events emitted before `onProgress` is called are
      // buffered above.
      const result = job(emit);

      return {
        onProgress(next: (event: TEvent) => void): void {
          listener = next;
          // Flush anything emitted before subscription, in order.
          while (buffer.length > 0) {
            const event = buffer.shift();
            if (event !== undefined) next(event);
          }
        },
        result,
      };
    },
  };
}
