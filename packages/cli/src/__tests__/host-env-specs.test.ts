/**
 * host-env-specs — the composed CLI registry + the aggregate env-surface for the
 * reference doc. Asserts every layer's variables are present exactly once and the
 * CLI infra reads coerce as the migrated sites expect.
 */

import { CORRELATION_ENV_SPECS } from '@opensip-cli/core';
import { GRAPH_ENV_SPECS } from '@opensip-cli/graph';
import { afterEach, describe, it, expect } from 'vitest';

import {
  BUNDLED_TOOL_ENV_SPECS,
  CLI_ENV_SPECS,
  CLI_INFRA_ENV_SPECS,
  PRE_SCOPE_ENV_SPECS,
  describeHostEnv,
  hostEnv,
} from '../env/host-env-specs.js';

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
    // The project-authored-tool allowlist var is declared (Phase 3) so the
    // generated env reference is complete; tool-trust reads it via an injectable
    // env seam (pre-scope), documented here.
    expect(canonicals).toContain('OPENSIP_CLI_ALLOW_PROJECT_TOOLS');
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

  it('declares the pre-scope allowance vars (theme colours + graph heap-preflight)', () => {
    const c = PRE_SCOPE_ENV_SPECS.map((s) => s.canonical);
    expect(c).toEqual([
      'NO_COLOR',
      'FORCE_COLOR',
      'COLORTERM',
      'TERM',
      'TERM_PROGRAM',
      'NODE_OPTIONS',
      'OPENSIP_HEAP_ELEVATED',
    ]);
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

  it('CLI_INFRA_ENV_SPECS covers the infra variables', () => {
    // ADR-0054 M4-E retired OPENSIP_CLI_EXTERNAL_WORKER (external tools now fork
    // by default; no opt-in gate) — it is no longer in the surface.
    expect(CLI_INFRA_ENV_SPECS.map((s) => s.canonical)).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OPENSIP_PROFILING',
      'TRACEPARENT',
      'OPENSIP_NO_UPDATE',
      'NO_UPDATE_NOTIFIER',
      // tool-command-surface-taxonomy Task 1.5: the Tier-3 internal-command reveal.
      'OPENSIP_CLI_SHOW_INTERNAL',
      'OPENSIP_CLI_SKIP_BUNDLED',
      'OPENSIP_CLI_SKIP_INSTALLED',
      'OPENSIP_CLI_ALLOW_INSTALLED_TOOLS',
      'OPENSIP_CLI_ALLOW_PROJECT_TOOLS',
      'OPENSIP_STATE_LOCK_WAIT_MS',
      'OPENSIP_STATE_LOCK_STALE_MS',
      'CI',
      'OPENSIP_CLI_TOOL_ENV_PASSTHROUGH',
    ]);
  });

  it('does NOT declare the retired OPENSIP_CLI_EXTERNAL_WORKER gate (ADR-0054 M4-E)', () => {
    expect(describeHostEnv().map((s) => s.canonical)).not.toContain('OPENSIP_CLI_EXTERNAL_WORKER');
  });

  it('CLI_ENV_SPECS = infra vars + the ten core CORRELATION_ENV_SPECS (spread, never re-declared)', () => {
    const correlationNames = CORRELATION_ENV_SPECS.map((s) => s.canonical);
    // The ten subprocess-correlation vars are owned by core; the host SPREADS
    // them, so CLI_ENV_SPECS = infra ++ exactly the core correlation set.
    expect(CLI_ENV_SPECS.map((s) => s.canonical)).toEqual([
      ...CLI_INFRA_ENV_SPECS.map((s) => s.canonical),
      ...correlationNames,
    ]);
    // The trailing slice is identity-equal to the core specs — the spread, not a
    // re-declared literal, is the linkage (no drift).
    expect(CLI_ENV_SPECS.slice(CLI_INFRA_ENV_SPECS.length)).toEqual([...CORRELATION_ENV_SPECS]);
    expect(correlationNames).toEqual([
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
    ]);
  });

  it('drift guard — CLI_ENV_SPECS contains EXACTLY the core correlation specs by canonical name (set-equality)', () => {
    // The complementary, order-independent guarantee to the ordered-array test
    // above: the correlation subset of CLI_ENV_SPECS is set-EQUAL to the core
    // CORRELATION_ENV_SPECS — every core correlation name is present, and none is
    // missing or duplicated. A future hand-added/removed correlation spec — or a
    // re-declared literal that drifts from core — fails here. Modeled on the
    // GRAPH_ENV_SPECS superset drift guard above (test code is exempt from the
    // no-bootstrap-tool-import rule).
    const cliNames = CLI_ENV_SPECS.map((s) => s.canonical);
    const coreCorrelationNames = new Set(CORRELATION_ENV_SPECS.map((s) => s.canonical));

    // The correlation subset of the CLI surface = the names that ARE core
    // correlation names (the infra prefix is excluded by this filter).
    const cliCorrelationSubset = cliNames.filter((n) => coreCorrelationNames.has(n));

    // No duplicates within the CLI correlation subset (the spread is honest).
    expect(new Set(cliCorrelationSubset).size).toBe(cliCorrelationSubset.length);
    // Set-equality: the CLI correlation subset is exactly the core set.
    expect(new Set(cliCorrelationSubset)).toEqual(coreCorrelationNames);
    // Coverage from the other direction: every core name appears in the CLI surface.
    for (const name of coreCorrelationNames) {
      expect(cliNames, `core correlation spec '${name}' missing from CLI_ENV_SPECS`).toContain(
        name,
      );
    }
  });

  it('OPENSIP_CLI_SKIP_INSTALLED coerces to boolean (default false)', () => {
    expect(hostEnv.get<boolean>('OPENSIP_CLI_SKIP_INSTALLED')).toBe(false);
    process.env.OPENSIP_CLI_SKIP_INSTALLED = '1';
    expect(hostEnv.get<boolean>('OPENSIP_CLI_SKIP_INSTALLED')).toBe(true);
    delete process.env.OPENSIP_CLI_SKIP_INSTALLED;
  });

  it('OPENSIP_CLI_SKIP_BUNDLED coerces to a trimmed id list (default empty)', () => {
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_SKIP_BUNDLED')).toEqual([]);
    process.env.OPENSIP_CLI_SKIP_BUNDLED = ' fitness , graph ';
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_SKIP_BUNDLED')).toEqual([
      'fitness',
      'graph',
    ]);
    delete process.env.OPENSIP_CLI_SKIP_BUNDLED;
  });

  it('OPENSIP_CLI_ALLOW_INSTALLED_TOOLS coerces on whitespace AND comma (default empty), agreeing with parseAllowlist', () => {
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_INSTALLED_TOOLS')).toEqual([]);
    process.env.OPENSIP_CLI_ALLOW_INSTALLED_TOOLS = 'my-plugin, other-tool';
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_INSTALLED_TOOLS')).toEqual([
      'my-plugin',
      'other-tool',
    ]);
    process.env.OPENSIP_CLI_ALLOW_INSTALLED_TOOLS = '*';
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_INSTALLED_TOOLS')).toEqual(['*']);
    delete process.env.OPENSIP_CLI_ALLOW_INSTALLED_TOOLS;
  });

  it('OPENSIP_CLI_ALLOW_PROJECT_TOOLS coerces on whitespace AND comma (default empty), agreeing with parseAllowlist', () => {
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_PROJECT_TOOLS')).toEqual([]);
    process.env.OPENSIP_CLI_ALLOW_PROJECT_TOOLS = 'my-audit, my-lint  my-bench';
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_PROJECT_TOOLS')).toEqual([
      'my-audit',
      'my-lint',
      'my-bench',
    ]);
    process.env.OPENSIP_CLI_ALLOW_PROJECT_TOOLS = '*';
    expect(hostEnv.get<readonly string[]>('OPENSIP_CLI_ALLOW_PROJECT_TOOLS')).toEqual(['*']);
    delete process.env.OPENSIP_CLI_ALLOW_PROJECT_TOOLS;
  });
});
