/**
 * @fileoverview `httpTarget` — an HTTP `Target` factory.
 *
 * The smallest BYO seam is a function, but most users point at an HTTP
 * endpoint. `httpTarget` wraps the built-in `fetch` (Node 24+) into a `Target`:
 * it forwards `ctx.signal` (so scenario abort + `abort` faults cancel the
 * request) and **throws on a non-OK status** so the driver classifies it as a
 * failure.
 *
 * Point this only at a target you own. For server-side fault injection (kill a
 * dependency, force 500s), put a fault-injectable proxy (e.g. Toxiproxy) in
 * front and aim `httpTarget` at the proxy — the harness drives and measures
 * around it.
 */

import type { Target, TargetContext } from './target.js';

/** Options for {@link httpTarget}. */
export interface HttpTargetOptions {
  /** Absolute URL to request. */
  readonly url: string;
  /** HTTP method. Defaults to `GET`. */
  readonly method?: string;
  /** Request headers. */
  readonly headers?: Record<string, string>;
  /** Optional request body. */
  readonly body?: string;
  /**
   * Predicate deciding whether a response counts as success. Defaults to
   * `200`–`299`. A non-OK status makes the request throw (a failure).
   */
  readonly okStatus?: (status: number) => boolean;
}

const defaultOk = (status: number): boolean => status >= 200 && status < 300;

/** Build an HTTP {@link Target} from a URL + method/headers/body. */
export function httpTarget(opts: HttpTargetOptions): Target {
  const isOk = opts.okStatus ?? defaultOk;
  /** @throws {Error} When the response status is not OK (per `isOk`). */
  async function request(ctx: TargetContext): Promise<void> {
    // @fitness-ignore-next-line no-raw-fetch -- BYO HTTP target for the chaos/load harness; raw fetch is the measured surface, abort handled via ctx.signal
    const res = await fetch(opts.url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctx.signal,
    });
    // Drain the body so the socket is freed even though we ignore the payload.
    try {
      await res.arrayBuffer();
    } catch {
      // @swallow-ok best-effort body drain; already-consumed or aborted bodies are fine to ignore.
    }
    if (!isOk(res.status)) {
      throw new Error(`httpTarget: ${opts.url} returned ${res.status}`);
    }
  }
  return request;
}
