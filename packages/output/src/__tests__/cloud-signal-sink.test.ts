import { buildSignalBatch, createSignal } from '@opensip-cli/core';
import { describe, it, expect, vi } from 'vitest';

import { createCloudSignalSink } from '../sink/cloud-signal-sink.js';

import type { Signal } from '@opensip-cli/core';

function sigs(n: number): Signal[] {
  return Array.from({ length: n }, (_, i) =>
    createSignal({ source: 't', severity: 'high', ruleId: `r${i}`, message: `m${i}` }),
  );
}
const batch = (n: number) => buildSignalBatch({ tool: 'fit', repo: {}, signals: sigs(n) });

describe('createCloudSignalSink', () => {
  it('POSTs with Authorization: Bearer + idempotency key and returns the accepted signal count', async () => {
    const seen: { key?: string; auth?: string; legacy?: string }[] = [];
    const fetchImpl = vi.fn((_url: unknown, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push({ key: h['Idempotency-Key'], auth: h['Authorization'], legacy: h['X-API-Key'] });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const sink = createCloudSignalSink({
      endpoint: 'https://x.test/api',
      apiKey: 'osk_secret',
      fetchImpl,
    });
    const b = batch(3);
    const r = await sink.emit(b);
    expect(r).toEqual({ accepted: 3, authRejected: false });
    expect(seen[0].auth).toBe('Bearer osk_secret');
    expect(seen[0].legacy).toBeUndefined();
    expect(seen[0].key).toBe(`${b.runId}:0`);
  });

  it('does not double-append /signals when the endpoint already ends in it', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: unknown) => {
      urls.push(String(url));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const sink = createCloudSignalSink({
      endpoint: 'https://x.test/api/signals',
      apiKey: 'k',
      fetchImpl,
    });
    await sink.emit(batch(1));
    expect(urls[0]).toBe('https://x.test/api/signals');
  });

  it('chunks a large batch into multiple POSTs', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(600)); // > 500-per-chunk cap → 2 chunks
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.accepted).toBe(600);
  });

  it('returns authRejected on a 403 (no accepted signals)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    ) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(2));
    expect(r).toEqual({ accepted: 0, authRejected: true, skippedReason: 'error' });
  });

  it('returns accepted:0 (never throws) when the endpoint is permanently unreachable', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(1));
    expect(r).toEqual({ accepted: 0, authRejected: false, skippedReason: 'error' });
  }, 15_000);

  it('emits nothing for an empty batch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(0));
    expect(r).toEqual({ accepted: 0, authRejected: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns accepted:0 (never throws) if an unexpected error escapes the transport', async () => {
    // Defense in depth: postChunked never throws, but emit must swallow any
    // unexpected error too. A non-string endpoint makes the internal
    // `.endsWith` URL-normalization throw synchronously inside emit's try.
    const badEndpoint = { endsWith: undefined } as unknown as string;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: badEndpoint, apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(2));
    expect(r).toEqual({ accepted: 0, authRejected: false, skippedReason: 'error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
