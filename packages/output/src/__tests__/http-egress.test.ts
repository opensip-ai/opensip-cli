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

  it('never throws when fetch rejects', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const r = await postChunked(args({ fetchImpl }));
    expect(r.outcome).toBe('failed');
    expect(r.errors.join(' ')).toContain('ECONNRESET');
  });
});
