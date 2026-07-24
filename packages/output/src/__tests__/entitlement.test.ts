import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { checkEntitlement, invalidateEntitlement } from '../sink/entitlement.js';

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'ent-'));
const ok = (entitled: boolean): Response => Response.json({ entitled }, { status: 200 });
const ENDPOINT = 'https://cloud.test/api';

describe('checkEntitlement', () => {
  it('caches a positive result and serves it without a second network call', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;
    const r1 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: net,
    });
    expect(r1).toEqual({ entitled: true, source: 'network' });

    const net2 = vi.fn(() => Promise.reject(new Error('must not call'))) as unknown as typeof fetch;
    const r2 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 2000,
      cacheDir,
      fetchImpl: net2,
    });
    expect(r2).toEqual({ entitled: true, source: 'cache' });
    expect(net2).not.toHaveBeenCalled();
  });

  it('authenticates the probe with Authorization: Bearer (never X-API-Key)', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;
    await checkEntitlement({
      apiKey: 'osk_secret',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: net,
    });
    expect(net).toHaveBeenCalledOnce();
    const [, init] = (net as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer osk_secret');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('normalizes a trailing endpoint slash before appending /entitlements', async () => {
    const cacheDir = await dir();
    const urls: string[] = [];
    const net = vi.fn((url: unknown) => {
      urls.push(String(url));
      return Promise.resolve(ok(true));
    }) as unknown as typeof fetch;

    await checkEntitlement({
      apiKey: 'k',
      endpoint: `${ENDPOINT}/`,
      now: 1000,
      cacheDir,
      fetchImpl: net,
    });

    expect(urls).toEqual([`${ENDPOINT}/entitlements`]);
  });

  it('re-checks over the network once the positive TTL elapses', async () => {
    const cacheDir = await dir();
    await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: vi.fn(() => Promise.resolve(ok(true))),
    });
    const net = vi.fn(() => Promise.resolve(ok(false))) as unknown as typeof fetch;
    const r = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000 + 7 * 3600 * 1000,
      cacheDir,
      fetchImpl: net,
    });
    expect(r.source).toBe('network');
    expect(net).toHaveBeenCalledOnce();
  });

  it('does not reuse an entitlement decision for a different endpoint', async () => {
    const cacheDir = await dir();
    await checkEntitlement({
      apiKey: 'shared-key',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: vi.fn(() => Promise.resolve(ok(true))),
    });

    const net = vi.fn(() => Promise.resolve(ok(false))) as unknown as typeof fetch;
    const result = await checkEntitlement({
      apiKey: 'shared-key',
      endpoint: 'https://other-cloud.test/api',
      now: 2000,
      cacheDir,
      fetchImpl: net,
    });

    expect(result).toEqual({ entitled: false, source: 'network' });
    expect(net).toHaveBeenCalledOnce();
  });

  it('treats a cache entry with malformed runtime types as a miss', async () => {
    const cacheDir = await dir();
    await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: vi.fn(() => Promise.resolve(ok(true))),
    });
    const cacheFiles = await readdir(cacheDir);
    const cacheFile = cacheFiles.find((name) => name.startsWith('entitlement-'));
    if (cacheFile === undefined) throw new Error('expected entitlement cache file');
    const path = join(cacheDir, cacheFile);
    const cached = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...cached, entitled: 'false' }), 'utf8');

    const net = vi.fn(() => Promise.resolve(ok(false))) as unknown as typeof fetch;
    const result = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 2000,
      cacheDir,
      fetchImpl: net,
    });

    expect(result).toEqual({ entitled: false, source: 'network' });
    expect(net).toHaveBeenCalledOnce();
  });

  it('caches a real negative briefly and serves it from cache within the negative TTL', async () => {
    const cacheDir = await dir();
    // A 403 is a real negative → it gets cached (negative TTL).
    const net = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    ) as unknown as typeof fetch;
    const r1 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: net,
    });
    expect(r1).toEqual({ entitled: false, source: 'network' });

    // 1 minute later (< 5m negative TTL) → served from cache, no second call.
    const net2 = vi.fn(() => Promise.reject(new Error('must not call'))) as unknown as typeof fetch;
    const r2 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000 + 60_000,
      cacheDir,
      fetchImpl: net2,
    });
    expect(r2).toEqual({ entitled: false, source: 'cache' });
    expect(net2).not.toHaveBeenCalled();

    // 6 minutes later (> 5m negative TTL) → cache expired, re-checks the network.
    const net3 = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;
    const r3 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000 + 6 * 60_000,
      cacheDir,
      fetchImpl: net3,
    });
    expect(r3.source).toBe('network');
    expect(net3).toHaveBeenCalledOnce();
  });

  it('treats 401/403 as a real negative (network source)', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    ) as unknown as typeof fetch;
    const r = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 0,
      cacheDir,
      fetchImpl: net,
    });
    expect(r).toEqual({ entitled: false, source: 'network' });
  });

  it('fails closed with no key', async () => {
    const cacheDir = await dir();
    const r = await checkEntitlement({ apiKey: '', endpoint: ENDPOINT, now: 0, cacheDir });
    expect(r).toEqual({ entitled: false, source: 'fail-closed' });
  });

  it('fails closed without sending the key to a plaintext endpoint', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;

    const result = await checkEntitlement({
      apiKey: 'secret',
      endpoint: 'http://cloud.test/api',
      now: 0,
      cacheDir,
      fetchImpl: net,
    });

    expect(result).toEqual({ entitled: false, source: 'fail-closed' });
    expect(net).not.toHaveBeenCalled();
  });

  it('fails closed promptly when root cancellation races a non-cooperative request', async () => {
    const cacheDir = await dir();
    const controller = new AbortController();
    const net = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const started = Date.now();
    const result = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 0,
      cacheDir,
      fetchImpl: net,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toEqual({ entitled: false, source: 'fail-closed' });
  });

  it.each([
    ['network error', () => Promise.reject(new Error('ECONNRESET'))],
    ['5xx', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['malformed body', () => Promise.resolve(new Response('not-json', { status: 200 }))],
  ])('fails closed on %s and writes no positive cache', async (_label, impl) => {
    const cacheDir = await dir();
    const r = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 0,
      cacheDir,
      fetchImpl: impl,
    });
    expect(r).toEqual({ entitled: false, source: 'fail-closed' });

    // A follow-up with a throwing fetch must still fail closed (no positive cache).
    const net = vi.fn(() => Promise.reject(new Error('x'))) as unknown as typeof fetch;
    const r2 = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1,
      cacheDir,
      fetchImpl: net,
    });
    expect(r2.entitled).toBe(false);
  });
});

describe('invalidateEntitlement', () => {
  it('deletes the cached decision so the next run re-checks the network', async () => {
    const cacheDir = await dir();
    // Seed a positive cache entry.
    await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1000,
      cacheDir,
      fetchImpl: vi.fn(() => Promise.resolve(ok(true))),
    });

    await invalidateEntitlement({ apiKey: 'k', cacheDir });

    // With the cache gone, the next check must hit the network again.
    const net = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;
    const r = await checkEntitlement({
      apiKey: 'k',
      endpoint: ENDPOINT,
      now: 1500,
      cacheDir,
      fetchImpl: net,
    });
    expect(r.source).toBe('network');
    expect(net).toHaveBeenCalledOnce();
  });

  it('never throws when there is no cache file to remove', async () => {
    const cacheDir = await dir();
    await expect(
      invalidateEntitlement({ apiKey: 'nonexistent', cacheDir }),
    ).resolves.toBeUndefined();
  });
});
