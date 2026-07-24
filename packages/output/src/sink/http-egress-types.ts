/** Public types for the shared chunked cloud-egress transport. */

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
  /** Auth-rejection status when present. */
  readonly authStatus?: 401 | 403;
  /** Saw a 429. */
  readonly throttled: boolean;
  /** Stopped early because the overall deadline elapsed. */
  readonly deadlineExceeded: boolean;
  readonly errors: readonly string[];
}

/** Arguments for posting pre-chunked bodies to a cloud receiver under a retry policy. */
export interface PostChunkedArgs {
  readonly url: string;
  readonly apiKey?: string;
  /** JSON-serializable bodies, one POST each. */
  readonly chunks: readonly unknown[];
  /** Stable idempotency key for the chunk at `ordinal` (same across retries). */
  readonly idempotencyKeyFor: (ordinal: number) => string;
  /** Per-chunk request timeout in ms. */
  readonly timeoutFor: (chunk: unknown, ordinal: number) => number;
  readonly policy: RetryPolicy;
  /** Log event prefix, e.g. `cli.report` or `cli.signal-sync`. */
  readonly evtPrefix: string;
  /** Caller headers; transport-owned headers always win. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock/sleep for deterministic tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Parent/root cancellation signal for the whole egress train. */
  readonly signal?: AbortSignal;
}
