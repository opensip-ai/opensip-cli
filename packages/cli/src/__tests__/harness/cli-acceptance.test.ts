/**
 * Self-test for the CLI acceptance harness.
 *
 * Covers the pure assertion core (`checkScenario`, `expectEnvelope`) plus one
 * real end-to-end scenario through `distRunner()` so the wrapper's binding to
 * the built CLI is exercised. The spawn/assert logic lives only here and in the
 * harness — the migrated e2e suites no longer carry their own spawn helpers.
 */

import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { runScenarios as coreRunScenarios } from '../../../../../scripts/lib/cli-acceptance-core.mjs';

import {
  checkScenario,
  distRunner,
  expectEnvelope,
  expectGraphCatalogNonEmpty,
  CLI_PKG_VERSION,
  type Scenario,
  type SpawnResult,
} from './cli-acceptance.js';

function spawnResult(over: Partial<SpawnResult> = {}): SpawnResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over };
}

/** Project a scenario result to the fields that must match across both lanes. */
function projectResult(r: { name: string; ok: boolean; failures: string[] }): {
  name: string;
  ok: boolean;
  failures: string[];
} {
  return { name: r.name, ok: r.ok, failures: r.failures };
}

describe('checkScenario', () => {
  it('flags an exitCode mismatch as a single failure', () => {
    const failures = checkScenario(spawnResult({ exitCode: 1 }), { exitCode: 0 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('exitCode');
  });

  it('passes when exitCode matches', () => {
    const failures = checkScenario(spawnResult({ exitCode: 0 }), { exitCode: 0 });
    expect(failures).toEqual([]);
  });

  it('honours exitCodeOneOf membership', () => {
    expect(checkScenario(spawnResult({ exitCode: 1 }), { exitCodeOneOf: [0, 1] })).toEqual([]);
    const miss = checkScenario(spawnResult({ exitCode: 2 }), { exitCodeOneOf: [0, 1] });
    expect(miss).toHaveLength(1);
    expect(miss[0]).toContain('one of');
  });

  it('checks stdoutIncludes', () => {
    expect(checkScenario(spawnResult({ stdout: 'hello world' }), { stdoutIncludes: 'world' })).toEqual([]);
    const miss = checkScenario(spawnResult({ stdout: 'hello' }), { stdoutIncludes: 'world' });
    expect(miss).toHaveLength(1);
    expect(miss[0]).toContain('stdout missing substring');
  });

  it('checks stdoutExcludes', () => {
    expect(checkScenario(spawnResult({ stdout: 'clean' }), { stdoutExcludes: 'oops' })).toEqual([]);
    const hit = checkScenario(spawnResult({ stdout: 'oops happened' }), { stdoutExcludes: 'oops' });
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('unexpectedly contains');
  });

  it('checks stderrIncludes', () => {
    expect(checkScenario(spawnResult({ stderr: 'warn: bad tag' }), { stderrIncludes: 'bad tag' })).toEqual([]);
    const miss = checkScenario(spawnResult({ stderr: '' }), { stderrIncludes: 'bad tag' });
    expect(miss).toHaveLength(1);
    expect(miss[0]).toContain('stderr missing substring');
  });

  it('runs a json predicate and surfaces its failures', () => {
    const result = spawnResult({ stdout: JSON.stringify({ ok: false }) });
    const failures = checkScenario(result, {
      json: (parsed) => ((parsed as { ok: boolean }).ok ? [] : ['ok was false']),
    });
    expect(failures).toEqual(['ok was false']);
  });

  it('reports a parse failure for malformed JSON', () => {
    const result = spawnResult({ stdout: 'not json{' });
    const failures = checkScenario(result, { json: () => [] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not valid JSON');
  });
});

describe('expectEnvelope', () => {
  const predicate = expectEnvelope({ tool: 'fit' });

  it('rejects an envelope missing schemaVersion', () => {
    const failures = predicate({ tool: 'fit', signals: [] });
    expect(failures.some((f) => f.includes('schemaVersion'))).toBe(true);
  });

  it('accepts a well-formed envelope', () => {
    expect(predicate({ schemaVersion: 2, tool: 'fit', signals: [] })).toEqual([]);
  });
});

describe('expectGraphCatalogNonEmpty', () => {
  const predicate = expectGraphCatalogNonEmpty();

  it('accepts a graph envelope with at least one unit', () => {
    expect(predicate({ schemaVersion: 2, tool: 'graph', signals: [], units: [{ slug: 'x' }] })).toEqual([]);
  });

  it('rejects an empty graph catalog (no signals, no units)', () => {
    const failures = predicate({ schemaVersion: 2, tool: 'graph', signals: [], units: [] });
    expect(failures.some((f) => f.includes('empty catalog'))).toBe(true);
  });

  it('rejects a non-graph tool', () => {
    const failures = predicate({ schemaVersion: 2, tool: 'fit', signals: [{}], units: [] });
    expect(failures.some((f) => f.includes('tool'))).toBe(true);
  });
});

describe('distRunner (real CLI)', () => {
  it('reports the package version for --version', () => {
    const { stdout, exitCode } = distRunner().run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_PKG_VERSION);
  });
});

describe('.mjs core / TS wrapper parity', () => {
  // The release script (smoke-pack.mjs) runs scenarios via the raw .mjs core;
  // the PR lane runs them via the TS wrapper. Both must produce identical
  // pass/fail + failure messages so assertion semantics cannot silently diverge.
  it('produces identical results via the wrapper and the raw core', () => {
    const scenarios: Scenario[] = [
      { name: 'version passes', args: ['--version'], expect: { exitCode: 0, stdoutIncludes: CLI_PKG_VERSION } },
      { name: 'version fails (deliberate)', args: ['--version'], expect: { exitCode: 1 } },
    ];
    const descriptor = {
      kind: 'node-script' as const,
      script: fileURLToPath(new URL('../../../dist/index.js', import.meta.url)),
    };
    const viaWrapper = distRunner().runScenarios(scenarios).map(projectResult);
    const viaCore = coreRunScenarios(descriptor, scenarios).results.map(projectResult);
    expect(viaWrapper).toEqual(viaCore);
    // sanity: the deliberate-fail scenario actually failed in both lanes
    expect(viaWrapper[1]?.ok).toBe(false);
  });
});
