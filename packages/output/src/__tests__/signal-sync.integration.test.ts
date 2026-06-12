/**
 * End-to-end validation of the cloud signal-sync pipeline
 * (resolveSignalSink → deferred entitlement → sink.emit → cloud egress),
 * against a routed mock fetch. The real OpenSIP Cloud ingestion + entitlement
 * endpoints live in the parent `opensip` repo and do not exist yet, so this
 * stands in for them and pins the load-bearing invariants: cloud-additive,
 * fail-closed, opt-out, and never-blocks-the-run.
 *
 * Drives the sink the same way the composition root's `deliverEnvelope` does —
 * build a `SignalBatch` and call `sink.emit(batch)` (the `CliOutput`-based
 * `emitRunSignals` driver was retired in ADR-0011 Phase 7).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSignalBatch, createSignal } from '@opensip-tools/core';
import { describe, it, expect, vi } from 'vitest';

import { resolveSignalSink } from '../sink/resolve-signal-sink.js';

import type { SignalBatch } from '@opensip-tools/core';

function batch(findings: number): SignalBatch {
  return buildSignalBatch({
    tool: 'fit',
    repo: {},
    signals: Array.from({ length: findings }, (_, i) =>
      createSignal({
        source: 'demo',
        severity: 'high',
        ruleId: `r${i}`,
        message: `m${i}`,
        code: { file: `src/f${i}.ts`, line: i + 1 },
      }),
    ),
  });
}

function routedFetch(entitled: boolean, signals: number | 'reject' = 200) {
  const calls = { entitlements: 0, signals: 0 };
  const impl = vi.fn((url: unknown) => {
    if (String(url).includes('/entitlements')) {
      calls.entitlements++;
      return Promise.resolve(Response.json({ entitled }, { status: 200 }));
    }
    calls.signals++;
    if (signals === 'reject') return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(new Response(null, { status: signals }));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function run(opts: { apiKey?: string; noCloud?: boolean; fetchImpl: typeof fetch }) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'sync-e2e-'));
  const sink = resolveSignalSink({
    apiKey: opts.apiKey,
    cloud: { endpoint: 'https://x.test/api' },
    noCloud: opts.noCloud,
    cacheDir,
    fetchImpl: opts.fetchImpl,
  });
  return sink.emit(batch(3));
}

describe('cloud signal sync — end to end', () => {
  it('entitled customer: signals are sent (cloud-additive)', async () => {
    const f = routedFetch(true);
    const r = await run({ apiKey: 'k', fetchImpl: f.impl });
    expect(r.accepted).toBe(3);
    expect(f.calls.signals).toBeGreaterThan(0);
  });

  it('not entitled: nothing is sent (fail path), /signals never hit', async () => {
    const f = routedFetch(false);
    const r = await run({ apiKey: 'k', fetchImpl: f.impl });
    expect(r).toEqual({ accepted: 0, authRejected: false, skippedReason: 'unentitled' });
    expect(f.calls.signals).toBe(0);
  });

  it('--no-cloud: no entitlement check, no send', async () => {
    const f = routedFetch(true);
    const r = await run({ apiKey: 'k', noCloud: true, fetchImpl: f.impl });
    expect(r.accepted).toBe(0);
    expect(f.calls.entitlements).toBe(0);
    expect(f.calls.signals).toBe(0);
  });

  it('cloud unreachable: emit returns accepted:0 and never throws (run unaffected)', async () => {
    const f = routedFetch(true, 'reject');
    const r = await run({ apiKey: 'k', fetchImpl: f.impl });
    expect(r).toEqual({ accepted: 0, authRejected: false, skippedReason: 'error' });
  }, 15_000);
});
