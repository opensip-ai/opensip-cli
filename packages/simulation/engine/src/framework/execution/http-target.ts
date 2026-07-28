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

import { createDeadlineError, ValidationError } from '@opensip-cli/core';

import { simulationErrorCatalog } from '../../errors/simulation-error-catalog.js';

import { ScenarioHttpTargetError } from './scenario-domain-error.js';

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
  /** Per-request deadline in milliseconds. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /**
   * Predicate deciding whether a response counts as success. Defaults to
   * `200`–`299`. A non-OK status makes the request throw (a failure).
   */
  readonly okStatus?: (status: number) => boolean;
}

const defaultOk = (status: number): boolean => status >= 200 && status < 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

/** @throws {ValidationError} When the timeout is outside the supported timer range. */
function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new ValidationError(
      `httpTarget timeoutMs must be a positive integer no greater than ${String(MAX_REQUEST_TIMEOUT_MS)}.`,
      {
        code: 'SIMULATION.SCENARIO.INVALID',
        definition: simulationErrorCatalog.require('SIMULATION.SCENARIO.INVALID'),
        metadata: { field: 'target.timeoutMs', condition: 'invalid' },
      },
    );
  }
}

/**
 * Build an HTTP {@link Target} from a URL + method/headers/body.
 *
 * @throws {ValidationError} When `timeoutMs` is not a supported positive integer.
 */
export function httpTarget(opts: HttpTargetOptions): Target {
  const isOk = opts.okStatus ?? defaultOk;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  validateTimeoutMs(timeoutMs);
  /** @throws {Error} When the response status is not OK (per `isOk`). */
  async function request(ctx: TargetContext): Promise<void> {
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([ctx.signal, deadlineSignal]);
    let res: Response;
    try {
      // @fitness-ignore-next-line no-raw-fetch -- BYO HTTP target for the chaos/load harness; raw fetch is the measured surface and is bounded by parent + deadline signals.
      res = await fetch(opts.url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: requestSignal,
      });
    } catch (error) {
      if (deadlineSignal.aborted && !ctx.signal.aborted) {
        throw createDeadlineError(
          `HTTP target request exceeded its ${String(timeoutMs)}ms deadline.`,
        );
      }
      throw error;
    }
    // Drain the body so the socket is freed even though we ignore the payload.
    try {
      await res.arrayBuffer();
    } catch (error) {
      if (requestSignal.aborted) {
        if (deadlineSignal.aborted && !ctx.signal.aborted) {
          throw createDeadlineError(
            `HTTP target response exceeded its ${String(timeoutMs)}ms deadline.`,
          );
        }
        throw error;
      }
      // @swallow-ok best-effort body drain; an already-consumed body is harmless.
    }
    if (!isOk(res.status)) {
      throw new ScenarioHttpTargetError(opts.url, res.status);
    }
  }
  return request;
}
