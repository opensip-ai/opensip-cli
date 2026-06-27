/**
 * run-correlation — the pure env codec (subprocess-correlation telemetry spec,
 * Phase 0). Covers the env↔correlation round-trip (Phase 0 step 4), runId-first
 * reads (B1), the M1 secret-hygiene guarantee (the API key is NEVER in the
 * correlation env), the absent-optionals contract (no empty sentinels), and the
 * `workerKind` coercion (an unknown value is `undefined`, not a throw).
 *
 * `correlationToEnv` is PURE — it never reads `process.env`. `correlationFromEnv`
 * reads `process.env` through a core `EnvRegistry`, so the env is mutated +
 * restored per test (`afterEach`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { correlationFromEnv, correlationToEnv, type RunCorrelation } from '../run-correlation.js';

// The OPENSIP_* keys the codec touches — snapshot/restore so no test leaks into
// another (and so the suite is hermetic regardless of the ambient shell env).
const ENV_KEYS = [
  'OPENSIP_RUN_ID',
  'OPENSIP_TOOL',
  'OPENSIP_PARENT_COMMAND',
  'OPENSIP_TRACE_ID',
  'OPENSIP_SHARD_ID',
  'OPENSIP_WORKER_KIND',
  'OPENSIP_REPO',
  'OPENSIP_REPO_ID',
  'OPENSIP_TENANT_ID',
  'OPENSIP_CHILD_INVOCATION_ID',
  'OPENSIP_API_KEY',
] as const;

const savedEnv = new Map<string, string | undefined>();

function clearCorrelationEnv(): void {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

/** Inject an env bag (the spawn-side product) into `process.env` for the reader. */
function loadEnv(env: Record<string, string>): void {
  clearCorrelationEnv();
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

const FULL: RunCorrelation = {
  runId: 'run_full',
  tool: 'graph',
  parentCommand: 'graph',
  traceId: '00-trace-span-01',
  repo: '/work/acme',
  repoId: 'repo-surrogate-7',
  tenantId: 'tenant-9',
  shardId: 'pkg:core',
  workerKind: 'shard',
  childInvocationId: 'child-1',
};

const MINIMAL: RunCorrelation = {
  runId: 'run_min',
  tool: 'fit',
  parentCommand: 'fit',
};

describe('correlationToEnv → correlationFromEnv round-trip', () => {
  it('round-trips the FULL bag through the env transport', () => {
    loadEnv(correlationToEnv(FULL));
    expect(correlationFromEnv()).toEqual(FULL);
  });

  it('round-trips the MINIMAL bag (runId/tool/parentCommand only)', () => {
    loadEnv(correlationToEnv(MINIMAL));
    expect(correlationFromEnv()).toEqual(MINIMAL);
  });

  it('omits absent optionals — no empty sentinel keys in the env bag', () => {
    const env = correlationToEnv(MINIMAL);
    // The reader's "omit absent optionals" contract starts at the writer: an
    // undefined optional is never emitted (no `OPENSIP_REPO=''`).
    expect(env).toEqual({
      OPENSIP_RUN_ID: 'run_min',
      OPENSIP_TOOL: 'fit',
      OPENSIP_PARENT_COMMAND: 'fit',
    });
    expect(Object.keys(env)).not.toContain('OPENSIP_REPO');
    expect(Object.keys(env)).not.toContain('OPENSIP_REPO_ID');

    loadEnv(env);
    const read = correlationFromEnv();
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('repo');
    expect(read).not.toHaveProperty('traceId');
  });
});

describe('correlationFromEnv', () => {
  it('returns undefined when NO correlation env is present', () => {
    clearCorrelationEnv();
    expect(correlationFromEnv()).toBeUndefined();
  });

  it('reads runId FIRST and independently (B1) — only OPENSIP_RUN_ID set', () => {
    loadEnv({ OPENSIP_RUN_ID: 'run_only' });
    const c = correlationFromEnv();
    expect(c?.runId).toBe('run_only');
    // The required fields fall back to the empty string (a bare bag, not a throw);
    // every OPTIONAL is omitted entirely.
    expect(c?.tool).toBe('');
    expect(c?.parentCommand).toBe('');
    expect(c).not.toHaveProperty('traceId');
    expect(c).not.toHaveProperty('repo');
    expect(c).not.toHaveProperty('shardId');
    expect(c).not.toHaveProperty('workerKind');
  });

  it('coerces an unrecognised OPENSIP_WORKER_KIND to undefined (no throw)', () => {
    loadEnv({ OPENSIP_RUN_ID: 'run_x', OPENSIP_WORKER_KIND: 'not-a-kind' });
    let c: RunCorrelation | undefined;
    expect(() => {
      c = correlationFromEnv();
    }).not.toThrow();
    expect(c?.runId).toBe('run_x');
    expect(c).not.toHaveProperty('workerKind');
  });

  it('accepts each valid OPENSIP_WORKER_KIND value', () => {
    for (const kind of ['shard', 'live-engine', 'external-tool'] as const) {
      loadEnv({ OPENSIP_RUN_ID: 'run_wk', OPENSIP_WORKER_KIND: kind });
      expect(correlationFromEnv()?.workerKind).toBe(kind);
    }
  });
});

describe('secret hygiene (M1) — the API key is NEVER in the correlation env', () => {
  it('never emits an OPENSIP_API_KEY key and never copies a process.env secret value', () => {
    // The codec is PURE: it does not read process.env, so an API key present in
    // the ambient env cannot leak into the bag it builds.
    process.env.OPENSIP_API_KEY = 'secret-xyz';
    const env = correlationToEnv(FULL);
    expect(Object.keys(env)).not.toContain('OPENSIP_API_KEY');
    expect(Object.values(env)).not.toContain('secret-xyz');
  });

  it('is value-blind, not value-scanning — a secret placed in a NAMED field is emitted under its own var', () => {
    // The guarantee is structural ("never the API-key env var / never reads
    // process.env"), NOT a value scan. If a caller accidentally routes the secret
    // into a named field (`repo`), the codec emits it under that field's var
    // (OPENSIP_REPO) — it does not special-case the value. This documents the
    // exact shape of the M1 guarantee so a future reader does not over-claim it.
    const env = correlationToEnv({ ...FULL, repo: 'secret-xyz' });
    expect(env.OPENSIP_REPO).toBe('secret-xyz');
    // Still never under OPENSIP_API_KEY — that var name is simply not in the table.
    expect(Object.keys(env)).not.toContain('OPENSIP_API_KEY');
  });

  it('ignores an OPENSIP_API_KEY present in the env on the READ side too', () => {
    // The reader's spec table has no OPENSIP_API_KEY entry, so an ambient API key
    // never surfaces as a RunCorrelation field.
    loadEnv({
      OPENSIP_RUN_ID: 'run_k',
      OPENSIP_TOOL: 'graph',
      OPENSIP_PARENT_COMMAND: 'graph',
    });
    process.env.OPENSIP_API_KEY = 'secret-xyz';
    const c = correlationFromEnv();
    expect(JSON.stringify(c)).not.toContain('secret-xyz');
  });
});
