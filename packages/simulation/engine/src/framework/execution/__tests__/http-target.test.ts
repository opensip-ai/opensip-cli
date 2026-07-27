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

  it('classifies a request deadline separately from its parent abort signal', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('expected a request signal');
            signal.addEventListener('abort', () => reject(signal.reason as Error), {
              once: true,
            });
          }),
      ),
    );

    const request = httpTarget({ url: 'https://x.test', timeoutMs: 25 })(ctx);
    deadline.abort(new Error('deadline'));

    await expect(request).rejects.toMatchObject({
      code: 'CORE.SYSTEM.DEADLINE_EXCEEDED',
    });
  });

  it('preserves a parent abort while the request is pending', async () => {
    const deadline = new AbortController();
    const parent = new AbortController();
    const reason = new Error('parent aborted');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('expected a request signal');
            signal.addEventListener('abort', () => reject(signal.reason as Error), {
              once: true,
            });
          }),
      ),
    );

    const request = httpTarget({ url: 'https://x.test' })({
      ...ctx,
      signal: parent.signal,
    });
    parent.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it('classifies a deadline while draining the response body', async () => {
    const deadline = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let bodyStartedResolve: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return Promise.resolve({
          status: 200,
          arrayBuffer: () => {
            bodyStartedResolve?.();
            return new Promise<ArrayBuffer>((_resolve, reject) => {
              requestSignal?.addEventListener(
                'abort',
                () => reject(requestSignal?.reason as Error),
                {
                  once: true,
                },
              );
            });
          },
        } as Response);
      }),
    );

    const request = httpTarget({ url: 'https://x.test', timeoutMs: 25 })(ctx);
    await bodyStarted;
    deadline.abort(new Error('deadline'));

    await expect(request).rejects.toMatchObject({
      code: 'CORE.SYSTEM.DEADLINE_EXCEEDED',
    });
  });

  it('preserves a parent abort while draining the response body', async () => {
    const deadline = new AbortController();
    const parent = new AbortController();
    const reason = new Error('parent aborted');
    let requestSignal: AbortSignal | undefined;
    let bodyStartedResolve: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return Promise.resolve({
          status: 200,
          arrayBuffer: () => {
            bodyStartedResolve?.();
            return new Promise<ArrayBuffer>((_resolve, reject) => {
              requestSignal?.addEventListener(
                'abort',
                () => reject(requestSignal?.reason as Error),
                {
                  once: true,
                },
              );
            });
          },
        } as Response);
      }),
    );

    const request = httpTarget({ url: 'https://x.test' })({
      ...ctx,
      signal: parent.signal,
    });
    await bodyStarted;
    parent.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it('ignores an ordinary body-drain error after receiving the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          status: 200,
          arrayBuffer: () => Promise.reject(new Error('body already consumed')),
        } as Response),
      ),
    );

    await expect(httpTarget({ url: 'https://x.test' })(ctx)).resolves.toBeUndefined();
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
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
