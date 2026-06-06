import { describe, it, expect, vi } from 'vitest';

import { postChunked, type PostChunkedArgs } from '../sink/http-egress.js';

/** A deterministic clock: `sleep` records delays and advances `now`. */
function clock(start = 0) {
  let t = start;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      t += ms;
      return Promise.resolve();
    },
    delays,
  };
}

/** A no-op sleep for tests that drive timing purely through a custom `now`. */
const noopSleep = (): Promise<void> => Promise.resolve();

function args(over: Partial<PostChunkedArgs> & Pick<PostChunkedArgs, 'fetchImpl'>): PostChunkedArgs {
  const c = clock();
  return {
    url: 'https://x.test/signals',
    apiKey: 'k',
    chunks: [{ a: 1 }],
    idempotencyKeyFor: (i) => `run:${i}`,
    timeoutFor: () => 1000,
    policy: { maxAttempts: 3, overallDeadlineMs: 60_000, honorRetryAfter: true },
    evtPrefix: 'cli.signal-sync',
    now: c.now,
    sleep: c.sleep,
    ...over,
  };
}

describe('postChunked', () => {
  it('retries a 429 then succeeds (throttled flagged)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: n++ === 0 ? 429 : 200 })),
    ) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(n).toBe(2);
    expect(r.acceptedChunks).toBe(1);
    expect(r.outcome).toBe('ok');
    expect(r.throttled).toBe(true);
  });

  it('honors Retry-After on a 429', async () => {
    const c = clock();
    let n = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        n++ === 0
          ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
          : new Response(null, { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    await postChunked(args({ fetchImpl, now: c.now, sleep: c.sleep }));
    expect(c.delays[0]).toBe(2000); // 2s, not the default backoff
  });

  it('retries a 5xx up to maxAttempts, then fails the chunk', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r.outcome).toBe('failed');
  });

  it('flags authRejected on 401 and stops immediately', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl, chunks: [{ a: 1 }, { b: 2 }] }));
    expect(r.authRejected).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-429 4xx', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('failed');
  });

  it('stops early when the overall deadline elapses', async () => {
    const c = clock();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
    const r = await postChunked(
      args({ fetchImpl, now: c.now, sleep: c.sleep, policy: { maxAttempts: 10, overallDeadlineMs: 100, honorRetryAfter: true } }),
    );
    expect(r.deadlineExceeded).toBe(true);
  });

  it('sends a stable Idempotency-Key per chunk, distinct per ordinal', async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn((_url: unknown, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    await postChunked(args({ fetchImpl, chunks: [{ a: 1 }, { b: 2 }] }));
    expect(keys).toEqual(['run:0', 'run:1']);
  });

  it('honors a Retry-After HTTP-date on a 503', async () => {
    let t = 0;
    const delays: number[] = [];
    const now = (): number => t;
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      t += ms;
      return Promise.resolve();
    };
    // HTTP-date 3s in the future (relative to now()=0).
    const retryDate = new Date(3000).toUTCString();
    let n = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        n++ === 0
          ? new Response(null, { status: 503, headers: { 'Retry-After': retryDate } })
          : new Response(null, { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl, now, sleep }));
    expect(r.outcome).toBe('ok');
    // Date.parse(retryDate) - now() === 3000ms, not the default exponential backoff.
    expect(delays[0]).toBe(3000);
  });

  it('ignores an unparseable Retry-After and falls back to backoff', async () => {
    let n = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        n++ === 0
          ? new Response(null, { status: 503, headers: { 'Retry-After': 'not-a-date' } })
          : new Response(null, { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    const c = clock();
    const r = await postChunked(args({ fetchImpl, now: c.now, sleep: c.sleep }));
    expect(r.outcome).toBe('ok');
    // Unparseable → default backoff (500ms base for attempt 1, plus jitter ≤ 250ms).
    expect(c.delays[0]).toBeGreaterThanOrEqual(500);
    expect(c.delays[0]).toBeLessThanOrEqual(750);
  });

  it('stops at the top of a later chunk when a prior chunk spent the deadline', async () => {
    // A slow server: the first chunk's request burns the whole wall-clock
    // budget, so the deadline check at the TOP of the next chunk's first
    // attempt trips before its request is ever sent.
    let t = 0;
    const now = (): number => t;
    const fetchImpl = vi.fn(() => {
      t += 200; // burns 200ms of the 150ms budget
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const r = await postChunked(
      args({
        fetchImpl,
        now,
        sleep: noopSleep,
        chunks: [{ a: 1 }, { b: 2 }],
        policy: { maxAttempts: 5, overallDeadlineMs: 150, honorRetryAfter: true },
      }),
    );
    expect(r.deadlineExceeded).toBe(true);
    // Chunk 0 was posted (and accepted); chunk 1 never fired (deadline spent).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.acceptedChunks).toBe(1);
    expect(r.outcome).toBe('partial');
  });

  it('never throws when fetch rejects', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(r.outcome).toBe('failed');
    expect(r.errors.join(' ')).toContain('ECONNRESET');
  });

  it('omits the X-API-Key header when no apiKey is supplied', async () => {
    let sawAuthHeader = true;
    const fetchImpl = vi.fn((_url: unknown, init: RequestInit) => {
      sawAuthHeader = 'X-API-Key' in (init.headers as Record<string, string>);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl, apiKey: undefined }));
    expect(r.outcome).toBe('ok');
    expect(sawAuthHeader).toBe(false);
  });

  it('records a non-Error rejection value as a string', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error value to exercise the String(error) coercion branch
    const fetchImpl = vi.fn(() => Promise.reject('plain string failure')) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(r.outcome).toBe('failed');
    expect(r.errors.join(' ')).toContain('plain string failure');
  });
});
