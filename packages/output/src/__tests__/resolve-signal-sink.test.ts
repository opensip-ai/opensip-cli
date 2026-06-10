import { access, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSignalBatch, createSignal, noopSignalSink } from '@opensip-tools/core';
import { describe, it, expect, vi } from 'vitest';

import { checkEntitlement } from '../sink/entitlement.js';
import { resolveSignalSink } from '../sink/resolve-signal-sink.js';

import type * as EntitlementModule from '../sink/entitlement.js';
import type { Signal } from '@opensip-tools/core';

vi.mock('../sink/entitlement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EntitlementModule>();
  return { ...actual, checkEntitlement: vi.fn(actual.checkEntitlement) };
});

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'sink-'));
const batch = (n: number) =>
  buildSignalBatch({
    tool: 'fit',
    repo: {},
    signals: Array.from(
      { length: n },
      (_, i): Signal =>
        createSignal({ source: 't', severity: 'high', ruleId: `r${i}`, message: 'm' }),
    ),
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
    expect(
      resolveSignalSink({ apiKey: 'k', cloud: { sync: false }, cacheDir: 'unused-cache-dir' }),
    ).toBe(noopSignalSink);
  });
  it('--no-cloud → no-op', () => {
    expect(resolveSignalSink({ apiKey: 'k', noCloud: true, cacheDir: 'unused-cache-dir' })).toBe(
      noopSignalSink,
    );
  });
  it('non-https endpoint → no-op (never sends the key)', () => {
    expect(
      resolveSignalSink({
        apiKey: 'k',
        cloud: { endpoint: 'http://insecure.test' },
        cacheDir: 'unused-cache-dir',
      }),
    ).toBe(noopSignalSink);
  });
});

describe('resolveSignalSink (deferred entitlement)', () => {
  it('emits via the cloud when entitled', async () => {
    const cacheDir = await dir();
    const sink = resolveSignalSink({
      apiKey: 'k',
      cloud: { endpoint: 'https://x.test/api' },
      cacheDir,
      fetchImpl: routedFetch(true),
    });
    const r = await sink.emit(batch(2));
    expect(r.accepted).toBe(2);
  });

  it('does not emit (and never hits /signals) when not entitled', async () => {
    const cacheDir = await dir();
    const fetchImpl = routedFetch(false);
    const sink = resolveSignalSink({
      apiKey: 'k',
      cloud: { endpoint: 'https://x.test/api' },
      cacheDir,
      fetchImpl,
    });
    const r = await sink.emit(batch(2));
    expect(r).toEqual({ accepted: 0, authRejected: false });
    const hitSignals = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => String(c[0]).includes('/signals'),
    );
    expect(hitSignals).toBe(false);
  });

  it('writes the first-run notice marker once, then skips it on the next emit', async () => {
    const cacheDir = await dir();
    const sink = resolveSignalSink({
      apiKey: 'k',
      cloud: { endpoint: 'https://x.test/api' },
      cacheDir,
      fetchImpl: routedFetch(true),
    });

    await sink.emit(batch(1)); // first emit writes the marker
    const marker = join(cacheDir, 'signal-sync-notice');
    await expect(access(marker)).resolves.toBeUndefined();

    // Second emit must take the "already shown" early-return (no second marker write).
    const r = await sink.emit(batch(1));
    expect(r.accepted).toBe(1);
    const entries = await readdir(cacheDir);
    expect(entries.filter((e) => e === 'signal-sync-notice')).toHaveLength(1);
  });

  it('busts the entitlement cache when the signals POST is auth-rejected', async () => {
    const cacheDir = await dir();
    // Entitlement says yes, but the /signals POST returns 403 → authRejected,
    // which must trigger invalidateEntitlement (delete the cached decision).
    const fetchImpl = vi.fn((url: unknown) =>
      String(url).includes('/entitlements')
        ? Promise.resolve(Response.json({ entitled: true }, { status: 200 }))
        : Promise.resolve(new Response(null, { status: 403 })),
    ) as unknown as typeof fetch;

    const sink = resolveSignalSink({
      apiKey: 'k',
      cloud: { endpoint: 'https://x.test/api' },
      cacheDir,
      fetchImpl,
    });
    const r = await sink.emit(batch(1));
    expect(r.authRejected).toBe(true);

    // The positive entitlement cache must have been deleted (no cache file left).
    const entries = await readdir(cacheDir);
    expect(entries.some((e) => e.startsWith('entitlement-'))).toBe(false);
  });

  it('never throws into the run when entitlement resolution unexpectedly fails', async () => {
    const cacheDir = await dir();
    vi.mocked(checkEntitlement).mockRejectedValueOnce(new Error('unexpected'));
    const sink = resolveSignalSink({
      apiKey: 'k',
      cloud: { endpoint: 'https://x.test/api' },
      cacheDir,
      fetchImpl: routedFetch(true),
    });
    const r = await sink.emit(batch(1));
    expect(r).toEqual({ accepted: 0, authRejected: false });
  });
});
