import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { checkEntitlement } from '../sink/entitlement.js';

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'ent-'));
const ok = (entitled: boolean): Response => Response.json({ entitled }, { status: 200 });
const ENDPOINT = 'https://cloud.test/api';

describe('checkEntitlement', () => {
  it('caches a positive result and serves it without a second network call', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() => Promise.resolve(ok(true))) as unknown as typeof fetch;
    const r1 = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 1000, cacheDir, fetchImpl: net });
    expect(r1).toEqual({ entitled: true, source: 'network' });

    const net2 = vi.fn(() => Promise.reject(new Error('must not call'))) as unknown as typeof fetch;
    const r2 = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 2000, cacheDir, fetchImpl: net2 });
    expect(r2).toEqual({ entitled: true, source: 'cache' });
    expect(net2).not.toHaveBeenCalled();
  });

  it('re-checks over the network once the positive TTL elapses', async () => {
    const cacheDir = await dir();
    await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 1000, cacheDir, fetchImpl: vi.fn(() => Promise.resolve(ok(true))) });
    const net = vi.fn(() => Promise.resolve(ok(false))) as unknown as typeof fetch;
    const r = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 1000 + 7 * 3600 * 1000, cacheDir, fetchImpl: net });
    expect(r.source).toBe('network');
    expect(net).toHaveBeenCalledOnce();
  });

  it('treats 401/403 as a real negative (network source)', async () => {
    const cacheDir = await dir();
    const net = vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))) as unknown as typeof fetch;
    const r = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 0, cacheDir, fetchImpl: net });
    expect(r).toEqual({ entitled: false, source: 'network' });
  });

  it('fails closed with no key', async () => {
    const cacheDir = await dir();
    const r = await checkEntitlement({ apiKey: '', endpoint: ENDPOINT, now: 0, cacheDir });
    expect(r).toEqual({ entitled: false, source: 'fail-closed' });
  });

  it.each([
    ['network error', () => Promise.reject(new Error('ECONNRESET'))],
    ['5xx', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['malformed body', () => Promise.resolve(new Response('not-json', { status: 200 }))],
  ])('fails closed on %s and writes no positive cache', async (_label, impl) => {
    const cacheDir = await dir();
    const r = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 0, cacheDir, fetchImpl: impl });
    expect(r).toEqual({ entitled: false, source: 'fail-closed' });

    // A follow-up with a throwing fetch must still fail closed (no positive cache).
    const net = vi.fn(() => Promise.reject(new Error('x'))) as unknown as typeof fetch;
    const r2 = await checkEntitlement({ apiKey: 'k', endpoint: ENDPOINT, now: 1, cacheDir, fetchImpl: net });
    expect(r2.entitled).toBe(false);
  });
});
