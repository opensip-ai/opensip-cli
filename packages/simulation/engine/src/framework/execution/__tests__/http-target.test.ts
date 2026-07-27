/**
 * @fileoverview Tests for the httpTarget helper (fetch stubbed).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpTarget } from '../http-target.js';

import type { TargetContext } from '../target.js';

const ctx: TargetContext = {
  signal: new AbortController().signal,
  correlationId: 'c',
};

const respond = (body: string, status: number) => () =>
  Promise.resolve(new Response(body, { status }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('httpTarget', () => {
  it('resolves on a 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(respond('ok', 200)));
    await expect(httpTarget({ url: 'https://x.test' })(ctx)).resolves.toBeUndefined();
  });

  it('throws on a non-2xx, carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(respond('no', 503)));
    await expect(httpTarget({ url: 'https://x.test' })(ctx)).rejects.toThrow(/503/);
  });

  it('forwards method, headers, and body with a composed abort signal', async () => {
    let observedInit: RequestInit | undefined;
    const f = vi.fn((_input: unknown, init?: RequestInit) => {
      observedInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    vi.stubGlobal('fetch', f);
    await httpTarget({
      url: 'https://x.test',
      method: 'POST',
      headers: { a: 'b' },
      body: 'p',
    })(ctx);
    expect(f).toHaveBeenCalledWith(
      'https://x.test',
      expect.objectContaining({
        method: 'POST',
        headers: { a: 'b' },
        body: 'p',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(observedInit?.signal).not.toBe(ctx.signal);
    expect(observedInit?.signal?.aborted).toBe(false);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid timeoutMs %s at construction',
    (timeoutMs) => {
      expect(() => httpTarget({ url: 'https://x.test', timeoutMs })).toThrow(/timeoutMs/);
    },
  );

  it('honours a custom okStatus predicate', async () => {
    vi.stubGlobal('fetch', vi.fn(respond('nope', 404)));
    await expect(
      httpTarget({ url: 'https://x.test', okStatus: (s) => s === 404 })(ctx),
    ).resolves.toBeUndefined();
  });
});
