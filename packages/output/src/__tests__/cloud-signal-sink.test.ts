import { buildSignalBatch, createSignal } from '@opensip-tools/core';
import { describe, it, expect, vi } from 'vitest';

import { createCloudSignalSink } from '../cloud-signal-sink.js';

import type { Signal } from '@opensip-tools/core';

function sigs(n: number): Signal[] {
  return Array.from({ length: n }, (_, i) => createSignal({ source: 't', severity: 'high', ruleId: `r${i}`, message: `m${i}` }));
}
const batch = (n: number) => buildSignalBatch({ tool: 'fit', repo: {}, signals: sigs(n) });

describe('createCloudSignalSink', () => {
  it('POSTs with X-API-Key + idempotency key and returns the accepted signal count', async () => {
    const seen: { key?: string; auth?: string }[] = [];
    const fetchImpl = vi.fn((_url: unknown, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push({ key: h['Idempotency-Key'], auth: h['X-API-Key'] });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'secret', fetchImpl });
    const b = batch(3);
    const r = await sink.emit(b);
    expect(r).toEqual({ accepted: 3, authRejected: false });
    expect(seen[0].auth).toBe('secret');
    expect(seen[0].key).toBe(`${b.runId}:0`);
  });

  it('chunks a large batch into multiple POSTs', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(600)); // > 500-per-chunk cap → 2 chunks
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.accepted).toBe(600);
  });

  it('returns authRejected on a 403 (no accepted signals)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(2));
    expect(r).toEqual({ accepted: 0, authRejected: true });
  });

  it('returns accepted:0 (never throws) when the endpoint is permanently unreachable', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(1));
    expect(r).toEqual({ accepted: 0, authRejected: false });
  }, 15_000);

  it('emits nothing for an empty batch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sink = createCloudSignalSink({ endpoint: 'https://x.test/api', apiKey: 'k', fetchImpl });
    const r = await sink.emit(batch(0));
    expect(r).toEqual({ accepted: 0, authRejected: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
