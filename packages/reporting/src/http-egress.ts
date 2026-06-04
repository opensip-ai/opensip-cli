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
import { logger } from '@opensip-tools/core';

/** Per-caller retry/throttle policy. */
export interface RetryPolicy {
  /** Max attempts per chunk. */
  readonly maxAttempts: number;
  /** Whole-batch wall-clock budget; once exceeded, stop and return partial. */
  readonly overallDeadlineMs: number;
  /** Parse + honor `Retry-After` on `429`/`503`. */
  readonly honorRetryAfter: boolean;
}

/** Structured outcome of a chunked POST. Never thrown — always returned. */
export interface EgressResult {
  /** Count of chunks the server acked with 2xx. */
  readonly acceptedChunks: number;
  /** Per-chunk success, indexed by ordinal (lets callers sum item counts). */
  readonly chunkResults: readonly boolean[];
  readonly outcome: 'ok' | 'partial' | 'failed';
  /** Saw a 401/403 — caller should bust any auth/entitlement cache. */
  readonly authRejected: boolean;
  /** Saw a 429. */
  readonly throttled: boolean;
  /** Stopped early because the overall deadline elapsed. */
  readonly deadlineExceeded: boolean;
  readonly errors: readonly string[];
}

/** Arguments for posting pre-chunked SARIF/signal bodies to a cloud receiver, one POST per body, under the retry policy. */
export interface PostChunkedArgs {
  readonly url: string;
  readonly apiKey?: string;
  /** JSON-serializable bodies, one POST each. */
  readonly chunks: readonly unknown[];
  /** Stable idempotency key for the chunk at `ordinal` (same across its retries). */
  readonly idempotencyKeyFor: (ordinal: number) => string;
  /** Per-chunk request timeout in ms. */
  readonly timeoutFor: (chunk: unknown, ordinal: number) => number;
  readonly policy: RetryPolicy;
  /** Log event prefix, e.g. `cli.report` or `cli.signal-sync`. */
  readonly evtPrefix: string;
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock/sleep for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MODULE_TAG = 'http-egress';

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

/** Exponential backoff with jitter (mirrors core's withRetry shape). */
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, 5000);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  const headersBase: Record<string, string> = { 'Content-Type': 'application/json' };
  if (args.apiKey) headersBase['X-API-Key'] = args.apiKey;

  const chunkResults: boolean[] = Array.from({ length: chunks.length }, () => false);
  const errors: string[] = [];
  let acceptedChunks = 0;
  let authRejected = false;
  let throttled = false;
  let deadlineExceeded = false;

  const deadlineLeft = (): number => policy.overallDeadlineMs - (now() - started);

  outer: for (let ci = 0; ci < chunks.length; ci++) {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (deadlineLeft() <= 0) {
        deadlineExceeded = true;
        break outer;
      }

      let retryAfterMs: number | undefined;
      try {
        const res = await fetchImpl(args.url, {
          method: 'POST',
          headers: { ...headersBase, 'Idempotency-Key': args.idempotencyKeyFor(ci) },
          body: JSON.stringify(chunks[ci]),
          signal: AbortSignal.timeout(args.timeoutFor(chunks[ci], ci)),
        });

        if (res.ok) {
          chunkResults[ci] = true;
          acceptedChunks++;
          logger.info({ evt: `${evtPrefix}.chunk`, module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, status: res.status });
          continue outer;
        }

        errors.push(`${res.status} ${res.statusText}`.trim());

        if (res.status === 401 || res.status === 403) {
          authRejected = true;
          logger.info({ evt: `${evtPrefix}.auth-rejected`, module: MODULE_TAG, status: res.status });
          break outer; // permanent auth failure — stop everything
        }
        if (!isTransient(res.status)) {
          logger.info({ evt: `${evtPrefix}.abort`, module: MODULE_TAG, status: res.status, remaining: chunks.length - ci - 1 });
          break outer; // other 4xx — retrying won't help; abort remaining
        }
        if (res.status === 429) {
          throttled = true;
          if (policy.honorRetryAfter) retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), now());
        } else if (res.status === 503 && policy.honorRetryAfter) {
          retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), now());
        }
      } catch (error) {
        // Network error / timeout — transient.
        errors.push(error instanceof Error ? error.message : String(error));
      }

      // Transient: retry if attempts remain and the deadline allows.
      if (attempt >= policy.maxAttempts) {
        logger.info({ evt: `${evtPrefix}.error`, module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, attempts: attempt });
        continue outer; // give up on this chunk, try the next
      }
      const wanted = retryAfterMs ?? backoffMs(attempt);
      const delay = Math.min(wanted, Math.max(0, deadlineLeft()));
      if (deadlineLeft() - delay <= 0) {
        deadlineExceeded = true;
        break outer;
      }
      logger.info({ evt: throttled ? `${evtPrefix}.throttled` : `${evtPrefix}.retry`, module: MODULE_TAG, chunk: `${ci + 1}/${chunks.length}`, attempt, delayMs: delay, retryAfterMs });
      await sleep(delay);
    }
  }

  let outcome: EgressResult['outcome'] = 'partial';
  if (acceptedChunks === chunks.length) outcome = 'ok';
  else if (acceptedChunks === 0) outcome = 'failed';

  return { acceptedChunks, chunkResults, outcome, authRejected, throttled, deadlineExceeded, errors };
}
