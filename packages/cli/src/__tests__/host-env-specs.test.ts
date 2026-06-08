/**
 * host-env-specs — the composed CLI registry + the aggregate env-surface for the
 * reference doc. Asserts every layer's variables are present exactly once and the
 * CLI infra reads coerce as the migrated sites expect.
 */

import { GRAPH_ENV_SPECS } from '@opensip-tools/graph';
import { afterEach, describe, it, expect } from 'vitest';

import { BUNDLED_TOOL_ENV_SPECS, CLI_ENV_SPECS, PRE_SCOPE_ENV_SPECS, describeHostEnv, hostEnv } from '../env/host-env-specs.js';

const TOUCHED = ['OPENSIP_NO_UPDATE', 'NO_UPDATE_NOTIFIER', 'OTEL_EXPORTER_OTLP_ENDPOINT'];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe('describeHostEnv', () => {
  it('aggregates every layer (config + bundled-tool + cli + pre-scope) with no duplicate canonical names', () => {
    const canonicals = describeHostEnv().map((s) => s.canonical);
    // One representative from each contributing layer.
    expect(canonicals).toContain('OPENSIP_API_KEY'); // config
    expect(canonicals).toContain('OPENSIP_HEAP_NO_MONITOR'); // bundled tool (graph)
    expect(canonicals).toContain('OTEL_EXPORTER_OTLP_ENDPOINT'); // cli
    expect(canonicals).toContain('NO_COLOR'); // pre-scope (cli-ui)
    expect(canonicals).toContain('NODE_OPTIONS'); // pre-scope (graph heap-preflight)
    // No duplicates — each variable is declared once across the whole surface.
    expect(new Set(canonicals).size).toBe(canonicals.length);
    // Every spec carries docs (the reference is generated from these).
    expect(describeHostEnv().every((s) => s.docs.length > 0)).toBe(true);
  });

  it('documents every bundled-tool env var (drift guard vs graph GRAPH_ENV_SPECS)', () => {
    // 3.0.0: the host documents bundled tools' env vars WITHOUT importing the
    // tool runtime (the `no-bootstrap-tool-import` guardrail). This test (test
    // code is exempt) keeps BUNDLED_TOOL_ENV_SPECS a superset of graph's actual
    // registry specs — graph adding an env var fails CI until it's documented.
    const documented = new Set(BUNDLED_TOOL_ENV_SPECS.map((s) => s.canonical));
    for (const spec of GRAPH_ENV_SPECS) {
      expect(
        documented.has(spec.canonical),
        `graph env var '${spec.canonical}' must be documented in BUNDLED_TOOL_ENV_SPECS (host-env-specs.ts)`,
      ).toBe(true);
    }
  });

  it('declares the pre-scope allowance vars (theme colours + NODE_OPTIONS)', () => {
    const c = PRE_SCOPE_ENV_SPECS.map((s) => s.canonical);
    expect(c).toEqual(['NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'TERM', 'TERM_PROGRAM', 'NODE_OPTIONS']);
  });
});

describe('hostEnv reads (CLI infra)', () => {
  it('coerces the update opt-outs to booleans (non-empty = true)', () => {
    expect(hostEnv.get<boolean>('OPENSIP_NO_UPDATE')).toBe(false); // unset → default
    process.env.OPENSIP_NO_UPDATE = '1';
    expect(hostEnv.get<boolean>('OPENSIP_NO_UPDATE')).toBe(true);
    process.env.NO_UPDATE_NOTIFIER = 'yes';
    expect(hostEnv.get<boolean>('NO_UPDATE_NOTIFIER')).toBe(true);
  });

  it('reads the OTEL endpoint as a raw string (the SDK gate)', () => {
    expect(hostEnv.get('OTEL_EXPORTER_OTLP_ENDPOINT')).toBeUndefined();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector:4318';
    expect(hostEnv.get('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('https://collector:4318');
  });

  it('CLI_ENV_SPECS covers the four infra variables', () => {
    expect(CLI_ENV_SPECS.map((s) => s.canonical)).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'TRACEPARENT',
      'OPENSIP_NO_UPDATE',
      'NO_UPDATE_NOTIFIER',
    ]);
  });
});
