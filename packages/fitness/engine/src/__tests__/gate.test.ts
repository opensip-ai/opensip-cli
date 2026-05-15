/**
 * Unit tests for the architecture-gate primitive.
 *
 * Covers:
 *   - saveBaseline: writes correct SARIF, creates parent dirs, idempotent overwrite
 *   - compareToBaseline: classifies added/resolved/unchanged correctly
 *   - Hash matching ignores line-number changes (D3 in plan.md)
 *   - Missing/invalid baseline → typed errors
 *   - renderGateCompareOutput: formats sections correctly per state
 *   - DEFAULT_BASELINE_PATH constant is what we documented
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
  DEFAULT_BASELINE_PATH,
  type GateCompareResult,
} from '../gate.js';

import type { CliOutput, FindingOutput } from '@opensip-tools/cli-shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<FindingOutput> = {}): FindingOutput {
  return {
    ruleId: 'no-console-log',
    message: 'console.log found',
    severity: 'error',
    filePath: 'src/index.ts',
    line: 42,
    ...overrides,
  };
}

function makeOutput(findings: FindingOutput[] = [makeFinding()]): CliOutput {
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: '2026-05-03T00:00:00.000Z',
    score: 90,
    passed: false,
    summary: { total: 1, passed: 0, failed: 1, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length },
    durationMs: 100,
    checks: [
      {
        checkSlug: 'no-console-log',
        passed: false,
        durationMs: 50,
        findings,
      },
    ],
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'opensip-tools-gate-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DEFAULT_BASELINE_PATH
// ---------------------------------------------------------------------------

describe('DEFAULT_BASELINE_PATH', () => {
  it('is the project-local path under the gitignored runtime dir', () => {
    expect(DEFAULT_BASELINE_PATH).toBe('opensip-tools/.runtime/baseline.sarif');
  });
});

// ---------------------------------------------------------------------------
// saveBaseline
// ---------------------------------------------------------------------------

describe('saveBaseline', () => {
  it('writes a valid SARIF document to the given path', () => {
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(makeOutput(), path);

    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.version).toBe('2.1.0');
    expect(Array.isArray(doc.runs)).toBe(true);
    expect(doc.runs[0].results.length).toBe(1);
  });

  it('creates parent directories that do not exist', () => {
    const path = join(tmpDir, 'nested', 'deep', 'baseline.sarif');
    saveBaseline(makeOutput(), path);
    expect(existsSync(path)).toBe(true);
  });

  it('overwrites an existing baseline file', () => {
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(makeOutput([makeFinding({ message: 'first' })]), path);
    saveBaseline(makeOutput([makeFinding({ message: 'second' })]), path);

    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.runs[0].results[0].message.text).toBe('second');
  });

  it('writes empty results array when there are no findings', () => {
    const path = join(tmpDir, 'baseline.sarif');
    const empty: CliOutput = { ...makeOutput(), checks: [] };
    saveBaseline(empty, path);

    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.runs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — happy paths
// ---------------------------------------------------------------------------

describe('compareToBaseline — classification', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over describe-scoped `tmpDir`
  function setupBaseline(findings: FindingOutput[]): string {
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(makeOutput(findings), path);
    return path;
  }

  it('reports STABLE when current matches baseline exactly', () => {
    const findings = [makeFinding()];
    const path = setupBaseline(findings);
    const result = compareToBaseline(makeOutput(findings), path);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('reports DEGRADED when current has new violations', () => {
    const path = setupBaseline([makeFinding({ filePath: 'a.ts', message: 'old' })]);
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ filePath: 'a.ts', message: 'old' }),
        makeFinding({ filePath: 'b.ts', message: 'new' }),
      ]),
      path,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0].filePath).toBe('b.ts');
    expect(result.added[0].message).toBe('new');
    expect(result.unchanged.length).toBe(1);
    expect(result.resolved).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  it('reports IMPROVED when violations are resolved with no new ones', () => {
    const path = setupBaseline([
      makeFinding({ filePath: 'a.ts', message: 'old1' }),
      makeFinding({ filePath: 'b.ts', message: 'old2' }),
    ]);
    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', message: 'old1' })]),
      path,
    );

    expect(result.added).toEqual([]);
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].filePath).toBe('b.ts');
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('reports both added and resolved in a mixed change set', () => {
    const path = setupBaseline([
      makeFinding({ filePath: 'kept.ts', message: 'kept' }),
      makeFinding({ filePath: 'gone.ts', message: 'gone' }),
    ]);
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ filePath: 'kept.ts', message: 'kept' }),
        makeFinding({ filePath: 'new.ts', message: 'new' }),
      ]),
      path,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0].filePath).toBe('new.ts');
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].filePath).toBe('gone.ts');
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(true);
  });

  it('handles fully empty baseline and current', () => {
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline({ ...makeOutput(), checks: [] }, path);
    const result = compareToBaseline({ ...makeOutput(), checks: [] }, path);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — D3 invariant: line shifts don't matter
// ---------------------------------------------------------------------------

describe('compareToBaseline — line-number invariance (D3)', () => {
  it('treats same (file, ruleId, message) at different lines as UNCHANGED', () => {
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(makeOutput([makeFinding({ line: 42 })]), path);

    // Same finding, but the file shifted — line moved to 50.
    const result = compareToBaseline(makeOutput([makeFinding({ line: 50 })]), path);

    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it('treats different message on same (file, ruleId) as added+resolved', () => {
    // E.g., complex-function on x.ts:foo where cc went from 22 to 28 — we WANT
    // this to register as a change, because the message includes the cc value.
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(
      makeOutput([
        makeFinding({ ruleId: 'complex-function', filePath: 'x.ts', message: 'cc=22' }),
      ]),
      path,
    );
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ ruleId: 'complex-function', filePath: 'x.ts', message: 'cc=28' }),
      ]),
      path,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0].message).toBe('cc=28');
    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].message).toBe('cc=22');
    expect(result.degraded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — error paths
// ---------------------------------------------------------------------------

describe('compareToBaseline — errors', () => {
  it('throws GateBaselineMissingError when baseline file does not exist', () => {
    const path = join(tmpDir, 'does-not-exist.sarif');
    expect(() => compareToBaseline(makeOutput(), path)).toThrow(GateBaselineMissingError);

    try {
      compareToBaseline(makeOutput(), path);
    } catch (error) {
      expect(error).toBeInstanceOf(GateBaselineMissingError);
      expect((error as GateBaselineMissingError).baselinePath).toBe(path);
      expect((error as Error).message).toContain('--gate-save');
    }
  });

  it('throws GateBaselineInvalidError on non-JSON content', () => {
    const path = join(tmpDir, 'bad.sarif');
    writeFileSync(path, 'this is not json');
    expect(() => compareToBaseline(makeOutput(), path)).toThrow(GateBaselineInvalidError);
  });

  it('throws GateBaselineInvalidError when top-level is not an object', () => {
    const path = join(tmpDir, 'bad.sarif');
    writeFileSync(path, '"a string"');
    expect(() => compareToBaseline(makeOutput(), path)).toThrow(GateBaselineInvalidError);
  });

  it('throws GateBaselineInvalidError when runs is missing', () => {
    const path = join(tmpDir, 'bad.sarif');
    writeFileSync(path, JSON.stringify({ version: '2.1.0' }));
    expect(() => compareToBaseline(makeOutput(), path)).toThrow(GateBaselineInvalidError);
  });

  it('throws GateBaselineInvalidError when runs is not an array', () => {
    const path = join(tmpDir, 'bad.sarif');
    writeFileSync(path, JSON.stringify({ version: '2.1.0', runs: 'oops' }));
    expect(() => compareToBaseline(makeOutput(), path)).toThrow(GateBaselineInvalidError);
  });

  it('error message includes the baseline path for debuggability', () => {
    const path = join(tmpDir, 'no-such.sarif');
    try {
      compareToBaseline(makeOutput(), path);
    } catch (error) {
      expect((error as Error).message).toContain(path);
    }
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — robustness against partial SARIF
// ---------------------------------------------------------------------------

describe('compareToBaseline — partial SARIF tolerance', () => {
  it('skips runs with non-array results', () => {
    const path = join(tmpDir, 'partial.sarif');
    writeFileSync(
      path,
      JSON.stringify({
        version: '2.1.0',
        runs: [
          { tool: { driver: { name: 'bad-run' } } }, // no results array
          {
            tool: { driver: { name: 'good-run' } },
            results: [
              {
                ruleId: 'kept',
                message: { text: 'kept message' },
                level: 'error',
                locations: [
                  { physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = compareToBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', ruleId: 'kept', message: 'kept message' })]),
      path,
    );
    // The single run with results matched current finding → unchanged.
    expect(result.unchanged.length).toBe(1);
    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it('handles SARIF results with missing locations (no filePath)', () => {
    const path = join(tmpDir, 'no-loc.sarif');
    writeFileSync(
      path,
      JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'tool' } },
            results: [{ ruleId: 'global-rule', message: { text: 'global issue' }, level: 'warning' }],
          },
        ],
      }),
    );

    // Current state has the same global-rule finding (no filePath).
    const current = makeOutput([
      { ruleId: 'global-rule', message: 'global issue', severity: 'warning' },
    ]);
    const result = compareToBaseline(current, path);
    expect(result.unchanged.length).toBe(1);
    expect(result.added).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderGateCompareOutput
// ---------------------------------------------------------------------------

describe('renderGateCompareOutput', () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- describe-scoped factory; could move out but reads better adjacent to its tests
  function makeResult(overrides: Partial<GateCompareResult> = {}): GateCompareResult {
    return {
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path; not a runtime filesystem operation
      baselinePath: '/tmp/baseline.sarif',
      added: [],
      resolved: [],
      unchanged: [],
      degraded: false,
      ...overrides,
    };
  }

  it('shows STABLE when nothing changed', () => {
    const text = renderGateCompareOutput(makeResult());
    expect(text).toContain('STABLE');
    expect(text).not.toContain('Added');
    expect(text).not.toContain('Resolved');
  });

  it('shows DEGRADED with added section when violations were introduced', () => {
    const text = renderGateCompareOutput(
      makeResult({
        added: [
          {
            hash: 'h1',
            ruleId: 'circular-import',
            message: 'a.ts → b.ts → a.ts',
            filePath: 'a.ts',
            severity: 'error',
          },
        ],
        degraded: true,
      }),
    );

    expect(text).toContain('DEGRADED');
    expect(text).toContain('Added (1)');
    expect(text).toContain('circular-import');
    expect(text).toContain('a.ts');
    expect(text).toContain('1 new violation');
  });

  it('shows IMPROVED when violations resolved and none added', () => {
    const text = renderGateCompareOutput(
      makeResult({
        resolved: [
          {
            hash: 'h1',
            ruleId: 'dead-code',
            message: 'unused export `foo`',
            filePath: 'x.ts',
            line: 10,
            severity: 'warning',
          },
        ],
      }),
    );

    expect(text).toContain('IMPROVED');
    expect(text).toContain('Resolved (1)');
    expect(text).toContain('dead-code');
  });

  it('truncates the unchanged section to a sample', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      hash: `h${i}`,
      ruleId: 'rule',
      message: `msg ${i}`,
      filePath: `f${i}.ts`,
      severity: 'warning' as const,
    }));
    const text = renderGateCompareOutput(makeResult({ unchanged: many }));

    expect(text).toContain('Unchanged (25)');
    expect(text).toContain('and 20 more'); // 25 total - 5 sample shown
  });

  it('uses singular grammar for one new violation, plural otherwise', () => {
    const oneAdded = renderGateCompareOutput(
      makeResult({
        added: [{ hash: 'h', ruleId: 'r', message: 'm', filePath: 'f', severity: 'error' }],
        degraded: true,
      }),
    );
    expect(oneAdded).toContain('1 new violation');
    expect(oneAdded).not.toContain('1 new violations');

    const twoAdded = renderGateCompareOutput(
      makeResult({
        added: [
          { hash: 'h1', ruleId: 'r', message: 'm', filePath: 'f1', severity: 'error' },
          { hash: 'h2', ruleId: 'r', message: 'm', filePath: 'f2', severity: 'error' },
        ],
        degraded: true,
      }),
    );
    expect(twoAdded).toContain('2 new violations');
  });

  it('renders no location when filePath is empty', () => {
    const text = renderGateCompareOutput(
      makeResult({
        added: [{ hash: 'h', ruleId: 'global-rule', message: 'no loc', filePath: '', severity: 'error' }],
        degraded: true,
      }),
    );
    expect(text).toContain('(no location)');
  });
});

// ---------------------------------------------------------------------------
// Integration: round-trip via filesystem
// ---------------------------------------------------------------------------

describe('integration — save then compare round-trip', () => {
  it('a saved-and-immediately-compared baseline reports STABLE', () => {
    const path = join(tmpDir, 'baseline.sarif');
    const output = makeOutput([
      makeFinding({ filePath: 'a.ts', message: 'm1' }),
      makeFinding({ filePath: 'b.ts', message: 'm2' }),
      makeFinding({ filePath: 'c.ts', message: 'm3' }),
    ]);

    saveBaseline(output, path);
    const result = compareToBaseline(output, path);

    expect(result.degraded).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unchanged.length).toBe(3);
  });

  it('writes a SARIF document that can serve as a future baseline', () => {
    // The SARIF written by saveBaseline should be readable by compareToBaseline
    // using a *different* CliOutput as the current state.
    const path = join(tmpDir, 'baseline.sarif');
    saveBaseline(
      makeOutput([makeFinding({ filePath: 'a.ts', message: 'one' })]),
      path,
    );

    // Same finding present + one new
    const result = compareToBaseline(
      makeOutput([
        makeFinding({ filePath: 'a.ts', message: 'one' }),
        makeFinding({ filePath: 'b.ts', message: 'two' }),
      ]),
      path,
    );
    expect(result.unchanged.length).toBe(1);
    expect(result.added.length).toBe(1);
    expect(result.added[0].filePath).toBe('b.ts');
  });
});
