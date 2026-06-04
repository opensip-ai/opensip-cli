/**
 * End-to-end validation of the cloud signal-sync pipeline
 * (resolveSignalSink → deferred entitlement → emitRunSignals → cloud sink),
 * against a routed mock fetch. The real OpenSIP Cloud ingestion + entitlement
 * endpoints live in the parent `opensip` repo and do not exist yet, so this
 * stands in for them and pins the load-bearing invariants: cloud-additive,
 * fail-closed, opt-out, and never-blocks-the-run.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { emitRunSignals } from '../emit-run-signals.js';
import { resolveSignalSink } from '../resolve-signal-sink.js';

import type { CliOutput } from '@opensip-tools/contracts';

function output(findings: number): CliOutput {
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: '2026-06-03T00:00:00.000Z',
    score: 0,
    passed: false,
    summary: { total: 1, passed: 0, failed: 1, errors: findings, warnings: 0 },
    durationMs: 1,
    checks: [
      {
        checkSlug: 'demo',
        passed: false,
        durationMs: 1,
        findings: Array.from({ length: findings }, (_, i) => ({
          ruleId: `r${i}`,
          message: `m${i}`,
          severity: 'error' as const,
          filePath: `src/f${i}.ts`,
          line: i + 1,
        })),
      },
    ],
  };
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
  return emitRunSignals({ output: output(3), tool: 'fit', cwd: '.', signalSink: sink, repo: {} });
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
    expect(r).toEqual({ accepted: 0, authRejected: false });
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
    expect(r).toEqual({ accepted: 0, authRejected: false });
  }, 15_000);
});
