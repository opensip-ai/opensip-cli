/**
 * Self-test for the CLI acceptance harness.
 *
 * Covers the pure assertion core (`checkScenario`, `expectEnvelope`) plus one
 * real end-to-end scenario through `distRunner()` so the wrapper's binding to
 * the built CLI is exercised. The spawn/assert logic lives only here and in the
 * harness — the migrated e2e suites no longer carry their own spawn helpers.
 */

import { describe, it, expect } from 'vitest';

import {
  checkScenario,
  distRunner,
  expectEnvelope,
  CLI_PKG_VERSION,
  type SpawnResult,
} from './cli-acceptance.js';

function spawnResult(over: Partial<SpawnResult> = {}): SpawnResult {
  return { stdout: '', stderr: '', exitCode: 0, ...over };
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

describe('distRunner (real CLI)', () => {
  it('reports the package version for --version', () => {
    const { stdout, exitCode } = distRunner().run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_PKG_VERSION);
  });
});
