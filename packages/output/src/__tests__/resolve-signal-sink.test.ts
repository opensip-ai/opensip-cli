import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSignalBatch, createSignal, noopSignalSink } from '@opensip-tools/core';
import { describe, it, expect, vi } from 'vitest';

import { resolveSignalSink } from '../resolve-signal-sink.js';

import type { Signal } from '@opensip-tools/core';

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'sink-'));
const batch = (n: number) =>
  buildSignalBatch({
    tool: 'fit',
    repo: {},
    signals: Array.from({ length: n }, (_, i): Signal => createSignal({ source: 't', severity: 'high', ruleId: `r${i}`, message: 'm' })),
  });

/** Route entitlement vs signals by URL. */
function routedFetch(entitled: boolean): typeof fetch {
  return vi.fn((url: unknown) =>
    String(url).includes('/entitlements')
      ? Promise.resolve(Response.json({ entitled }, { status: 200 }))
      : Promise.resolve(new Response(null, { status: 200 })),
  );
}

describe('resolveSignalSink (opt-out paths return the no-op, no IO)', () => {
  it('no API key → no-op', () => {
    expect(resolveSignalSink({ cacheDir: 'unused-cache-dir' })).toBe(noopSignalSink);
  });
  it('cloud.sync:false → no-op', () => {
    expect(resolveSignalSink({ apiKey: 'k', cloud: { sync: false }, cacheDir: 'unused-cache-dir' })).toBe(noopSignalSink);
  });
  it('--no-cloud → no-op', () => {
    expect(resolveSignalSink({ apiKey: 'k', noCloud: true, cacheDir: 'unused-cache-dir' })).toBe(noopSignalSink);
  });
  it('non-https endpoint → no-op (never sends the key)', () => {
    expect(resolveSignalSink({ apiKey: 'k', cloud: { endpoint: 'http://insecure.test' }, cacheDir: 'unused-cache-dir' })).toBe(noopSignalSink);
  });
});

describe('resolveSignalSink (deferred entitlement)', () => {
  it('emits via the cloud when entitled', async () => {
    const cacheDir = await dir();
    const sink = resolveSignalSink({ apiKey: 'k', cloud: { endpoint: 'https://x.test/api' }, cacheDir, fetchImpl: routedFetch(true) });
    const r = await sink.emit(batch(2));
    expect(r.accepted).toBe(2);
  });

  it('does not emit (and never hits /signals) when not entitled', async () => {
    const cacheDir = await dir();
    const fetchImpl = routedFetch(false);
    const sink = resolveSignalSink({ apiKey: 'k', cloud: { endpoint: 'https://x.test/api' }, cacheDir, fetchImpl });
    const r = await sink.emit(batch(2));
    expect(r).toEqual({ accepted: 0, authRejected: false });
    const hitSignals = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('/signals'));
    expect(hitSignals).toBe(false);
  });
});
