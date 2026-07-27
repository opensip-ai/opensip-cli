/**
 * Shared chunked cloud-egress transport (ADR-0008).
 *
 * Both cloud paths POST through here: `reportToCloud` (SARIF, `--report-to`)
 * and the OpenSIP Cloud signal sink. The transport is the *mechanism*; each
 * caller supplies its own *policy* (Strategy) and applies its own failure
 * semantics to the returned {@link EgressResult} — `reportToCloud` maps failure
 * to exit 4, the signal sink swallows. **`postChunked` never throws.**
 *
 * Unlike the prior SARIF-only loop (which only retried `fetch` *throws* and
 * dropped a chunk on an HTTP `429`/`5xx`), this retries `429`/`5xx` at the
 * chunk level, honors `Retry-After`, bounds total work by an overall deadline,
 * and sends a stable `Idempotency-Key` per chunk so a retried-but-stored chunk
 * is de-duplicated server-side.
 */
import {
  NetworkError,
  SystemError,
  ValidationError,
  coreSystemErrorCatalog,
  logger,
  normalizeFailure,
  scrubText,
  toOperatorFailureProjection,
  withRetry,
} from '@opensip-cli/core';

import { outputErrorCatalog } from '../errors/output-error-catalog.js';

import { isHttpsUrl } from './https-url.js';

import type { EgressResult, PostChunkedArgs } from './http-egress-types.js';

const EGRESS_REQUEST_INVALID = outputErrorCatalog.require('OUTPUT.EGRESS.REQUEST_INVALID');
const DEADLINE_EXCEEDED = coreSystemErrorCatalog.require('CORE.SYSTEM.DEADLINE_EXCEEDED');

export type { EgressResult, PostChunkedArgs, RetryPolicy } from './http-egress-types.js';

const MODULE_TAG = 'http-egress';
const TRANSPORT_HEADER_NAMES = new Set(['authorization', 'content-type', 'idempotency-key']);

function isTransient(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into a delay in ms. */
function parseRetryAfter(headerVal: string | null, now: number): number | undefined {
  if (!headerVal) return undefined;
  const secs = Number(headerVal);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerVal);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class HttpResponseError extends NetworkError {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${String(status)} ${statusText}`.trim(), {
      statusCode: status,
      metadata: { status },
    });
    this.name = 'HttpResponseError';
  }
}

function asHttpResponseError(error: unknown): HttpResponseError | undefined {
  try {
    return error instanceof HttpResponseError ? error : undefined;
  } catch {
    return undefined;
  }
}

function safeOperatorMessage(error: unknown): string {
  const projection = toOperatorFailureProjection(normalizeFailure(error));
  return scrubText(
    typeof projection.message === 'string' ? projection.message : 'The operation failed.',
    300,
  );
}

function safeLog(level: 'info' | 'warn', entry: Readonly<Record<string, unknown>>): void {
  try {
    logger[level](entry);
  } catch {
    // Egress is best-effort; a diagnostic sink cannot violate never-throws.
  }
}

function requestSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(
    Number.isFinite(timeoutMs) ? Math.min(2_147_483_647, Math.max(0, Math.floor(timeoutMs))) : 0,
  );
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

function signalError(signal: AbortSignal, fallback: string): Error {
  try {
    if (signal.reason instanceof Error) return signal.reason;
    if (typeof signal.reason === 'string') return new Error(scrubText(signal.reason, 300));
  } catch {
    // Hostile reason access falls through to a constant failure.
  }
  return new Error(fallback);
}

/** @throws {unknown} When fetch rejects, cancellation wins, or the request deadline elapses. */
async function waitForFetch(response: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw signalError(signal, 'request aborted');
  let detach = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signalError(signal, 'request aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([response, aborted]);
  } finally {
    detach();
  }
}

/** @throws {unknown} When sleep rejects or cancellation wins. */
async function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return await sleep(ms);
  if (signal.aborted) throw signalError(signal, 'egress cancelled');
  let detach = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signalError(signal, 'egress cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    detach();
  }
}

/**
 * POST each chunk with bounded per-chunk retries on `429`/`5xx`/transport
 * errors, honoring `Retry-After`, an overall deadline, and stable idempotency
 * keys. Returns an {@link EgressResult}; never throws.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- network transport: per-chunk retry with status classification, Retry-After, and an overall deadline; the phases read better inline than split across helpers
export async function postChunked(args: PostChunkedArgs): Promise<EgressResult> {
  const { chunks, policy, evtPrefix } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? defaultSleep;
  const started = now();
  const overallDeadlineMs =
    Number.isFinite(policy.overallDeadlineMs) && policy.overallDeadlineMs > 0
      ? policy.overallDeadlineMs
      : 0;

  if (args.apiKey && !isHttpsUrl(args.url)) {
    const detail = 'credential-bearing egress requires an https:// URL';
    safeLog('warn', {
      evt: `${evtPrefix}.insecure-endpoint`,
      module: MODULE_TAG,
      url: scrubText(args.url, 512),
    });
    return {
      acceptedChunks: 0,
      chunkResults: Array.from({ length: chunks.length }, () => false),
      outcome: 'failed',
      authRejected: false,
      throttled: false,
      deadlineExceeded: false,
      errors: [detail],
    };
  }

  // Keep transport-owned names out of the caller bag case-insensitively.
  // Otherwise Fetch combines `authorization` + `Authorization` into one value
  // instead of letting the transport's auth/idempotency values win.
  const headersBase: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(args.extraHeaders ?? {})) {
      if (!TRANSPORT_HEADER_NAMES.has(name.toLowerCase())) headersBase[name] = value;
    }
  } catch {
    return {
      acceptedChunks: 0,
      chunkResults: Array.from({ length: chunks.length }, () => false),
      outcome: 'failed',
      authRejected: false,
      throttled: false,
      deadlineExceeded: false,
      errors: ['request headers could not be inspected'],
    };
  }
  headersBase['Content-Type'] = 'application/json';
  // OpenSIP Cloud authenticates the `osk_` key as an `Authorization: Bearer`
  // token only (the api-key strategy matches `Bearer osk_`); the historical
  // `X-API-Key` header never reached a route and is removed outright — no
  // dual-header shim (DEC-587). `apiKey` carries the raw `osk_…` token; do not
  // strip or transform it. The HTTPS guard above keeps this credential off
  // plain HTTP.
  if (args.apiKey) headersBase.Authorization = `Bearer ${args.apiKey}`;

  // Evaluate idempotency keys exactly once before any request. A retried POST
  // must reuse a non-empty bounded key; a stateful callback cannot silently
  // generate a different key on each attempt and amplify writes.
  const idempotencyKeys: string[] = [];
  try {
    for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
      const key = args.idempotencyKeyFor(ordinal);
      if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
        throw new ValidationError('invalid idempotency key', {
          code: EGRESS_REQUEST_INVALID.code,
          definition: EGRESS_REQUEST_INVALID,
          metadata: { field: 'idempotencyKey' },
        });
      }
      idempotencyKeys.push(key);
    }
  } catch {
    return {
      acceptedChunks: 0,
      chunkResults: Array.from({ length: chunks.length }, () => false),
      outcome: 'failed',
      authRejected: false,
      throttled: false,
      deadlineExceeded: false,
      errors: ['a stable bounded idempotency key is required for POST retries'],
    };
  }

  const chunkResults: boolean[] = Array.from({ length: chunks.length }, () => false);
  const errors: string[] = [];
  let acceptedChunks = 0;
  let authRejected = false;
  let authStatus: 401 | 403 | undefined;
  let throttled = false;
  let deadlineExceeded = false;

  const deadlineLeft = (): number => overallDeadlineMs - (now() - started);

  for (let ci = 0; ci < chunks.length; ci++) {
    if (deadlineLeft() <= 0) {
      deadlineExceeded = true;
      break;
    }
    const idempotencyKey = idempotencyKeys[ci];
    if (idempotencyKey === undefined) {
      errors.push('idempotency key resolution failed');
      break;
    }

    try {
      const responseStatus = await withRetry(
        async () => {
          if (deadlineLeft() <= 0) {
            // The registered deadline code, so a caller can tell an exhausted egress budget
            // from a transport fault: `withRetry` treats them differently and so does an
            // operator reading the exit class.
            throw new SystemError('egress deadline exceeded', {
              code: DEADLINE_EXCEEDED.code,
              definition: DEADLINE_EXCEEDED,
            });
          }
          const requestTimeoutMs = Math.min(
            args.timeoutFor(chunks[ci], ci),
            Math.max(0, deadlineLeft()),
          );
          const signal = requestSignal(requestTimeoutMs, args.signal);
          let res: Response;
          try {
            res = await waitForFetch(
              fetchImpl(args.url, {
                method: 'POST',
                headers: { ...headersBase, 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify(chunks[ci]),
                signal,
              }),
              signal,
            );
          } catch (error) {
            if (args.signal?.aborted) throw error;
            throw new NetworkError(`HTTP request failed: ${safeOperatorMessage(error)}`, {
              cause: error,
            });
          }

          if (res.ok) return res.status;

          if (res.status === 429) throttled = true;
          const retryAfterMs =
            policy.honorRetryAfter && (res.status === 429 || res.status === 503)
              ? parseRetryAfter(res.headers.get('Retry-After'), now())
              : undefined;
          throw new HttpResponseError(res.status, res.statusText, retryAfterMs);
        },
        {
          maxAttempts: policy.maxAttempts,
          initialDelayMs: 500,
          maxDelayMs: 5000,
          backoffMultiplier: 2,
          jitter: 'equal',
          useDefinitionRetry: false,
          signal: args.signal,
          deadlineMs: started + overallDeadlineMs,
          shouldRetry: (error) => {
            const responseError = asHttpResponseError(error);
            return responseError === undefined ? true : isTransient(responseError.status);
          },
          retryDelayMs: (error, _attempt, computed) => {
            const responseError = asHttpResponseError(error);
            return responseError?.retryAfterMs ?? computed;
          },
          onRetry: (attempt, error, delayMs) => {
            const responseError = asHttpResponseError(error);
            const retryAfterMs = responseError?.retryAfterMs;
            safeLog('info', {
              evt: responseError?.status === 429 ? `${evtPrefix}.throttled` : `${evtPrefix}.retry`,
              module: MODULE_TAG,
              chunk: `${ci + 1}/${chunks.length}`,
              attempt,
              delayMs,
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            });
          },
          clock: {
            now,
            random: Math.random,
            sleep: (ms, signal) => sleepWithSignal(sleep, ms, signal),
          },
        },
      );
      chunkResults[ci] = true;
      acceptedChunks += 1;
      safeLog('info', {
        evt: `${evtPrefix}.chunk`,
        module: MODULE_TAG,
        chunk: `${ci + 1}/${chunks.length}`,
        status: responseStatus,
      });
    } catch (error) {
      if (args.signal?.aborted) {
        errors.push('egress cancelled');
        break;
      }
      const responseError = asHttpResponseError(error);
      if (responseError === undefined) {
        errors.push(safeOperatorMessage(error));
      } else {
        errors.push(scrubText(responseError.message, 300));
        if (responseError.status === 401 || responseError.status === 403) {
          authRejected = true;
          authStatus = responseError.status;
          safeLog('warn', {
            evt: `${evtPrefix}.auth-rejected`,
            module: MODULE_TAG,
            status: responseError.status,
          });
          break;
        }
        if (!isTransient(responseError.status)) {
          safeLog('warn', {
            evt: `${evtPrefix}.abort`,
            module: MODULE_TAG,
            status: responseError.status,
            remaining: chunks.length - ci - 1,
          });
          break;
        }
      }
      if (deadlineLeft() <= 0) {
        deadlineExceeded = true;
        break;
      }
      safeLog('warn', {
        evt: `${evtPrefix}.error`,
        module: MODULE_TAG,
        chunk: `${ci + 1}/${chunks.length}`,
        attempts: policy.maxAttempts,
      });
    }
  }

  let outcome: EgressResult['outcome'] = 'partial';
  if (acceptedChunks === chunks.length) outcome = 'ok';
  else if (acceptedChunks === 0) outcome = 'failed';

  safeLog(outcome === 'ok' ? 'info' : 'warn', {
    evt: `${evtPrefix}.complete`,
    module: MODULE_TAG,
    outcome,
    acceptedChunks,
    chunkCount: chunks.length,
    throttled,
    deadlineExceeded,
    cancelled: args.signal?.aborted === true,
  });

  return {
    acceptedChunks,
    chunkResults,
    outcome,
    authRejected,
    ...(authStatus === undefined ? {} : { authStatus }),
    throttled,
    deadlineExceeded,
    errors,
  };
}
