/**
 * JSON renderer — emits a CliOutput-shaped document from graph signals.
 *
 * Covers both entry points: `renderJson`/`buildCliOutput` (Signal[] with
 * the severity heuristic, per-rule grouping, and the fast-mode marker)
 * and `buildCliOutputFromFindings` (pre-normalized FindingOutput[] from
 * the per-package fan-out).
 */

import { describe, expect, it } from 'vitest';

import { buildCliOutput, buildCliOutputFromFindings, renderJson } from '../json.js';

import type { CliOutput, FindingOutput } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

function signal(over: Partial<Signal> = {}): Signal {
  return {
    ruleId: 'graph.dead-end',
    message: 'unreachable',
    severity: 'high',
    filePath: 'src/a.ts',
    line: 3,
    column: 1,
    ...over,
  } as Signal;
}

describe('buildCliOutput', () => {
  it('maps critical/high severities to errors and groups findings by ruleId', () => {
    const out = buildCliOutput(
      [
        signal({ ruleId: 'r1', severity: 'high' }),
        signal({ ruleId: 'r1', severity: 'critical' }),
        signal({ ruleId: 'r2', severity: 'medium' }),
      ],
      'graph',
    );
    expect(out.tool).toBe('graph');
    expect(out.checks).toHaveLength(2);
    // r1 has error-severity findings → fails; r2 is warning-only → passes.
    const r1 = out.checks.find((c) => c.checkSlug === 'r1');
    const r2 = out.checks.find((c) => c.checkSlug === 'r2');
    expect(r1?.passed).toBe(false);
    expect(r2?.passed).toBe(true);
    expect(out.summary.errors).toBe(2);
    expect(out.summary.warnings).toBe(1);
    expect(out.passed).toBe(false);
  });

  it('treats a warnings-only run as fully passed (score 100, passed true)', () => {
    const out = buildCliOutput([signal({ severity: 'low' })], 'graph');
    expect(out.summary.errors).toBe(0);
    expect(out.passed).toBe(true);
    expect(out.score).toBe(100);
  });

  it('omits the resolutionMode marker for exact runs and includes it for fast', () => {
    const exact = buildCliOutput([], 'graph', 'exact');
    expect('resolutionMode' in exact).toBe(false);
    const fast = buildCliOutput([], 'graph', 'fast') as CliOutput & { resolutionMode?: string };
    expect(fast.resolutionMode).toBe('fast');
  });

  it('carries the durationMs argument onto the CliOutput', () => {
    const out = buildCliOutput([signal()], 'graph', undefined, 1234);
    expect(out.durationMs).toBe(1234);
  });

  it('defaults durationMs to 0 when not supplied', () => {
    const out = buildCliOutput([signal()], 'graph');
    expect(out.durationMs).toBe(0);
  });

  it('threads scalar signal metadata onto findings, filtering non-scalars', () => {
    const out = buildCliOutput(
      [signal({ ruleId: 'graph:large-function', metadata: { bodyLines: 321, label: 'big', flag: true, nested: { a: 1 }, arr: [1, 2] } })],
      'graph',
    );
    const finding = out.checks[0]?.findings[0];
    expect(finding?.metadata).toEqual({ bodyLines: 321, label: 'big', flag: true });
    // Non-scalar values (objects, arrays) are dropped.
    expect(finding?.metadata && 'nested' in finding.metadata).toBe(false);
    expect(finding?.metadata && 'arr' in finding.metadata).toBe(false);
  });

  it('omits the metadata field entirely when no scalar metadata survives', () => {
    const out = buildCliOutput([signal({ metadata: { nested: { a: 1 } } })], 'graph');
    const finding = out.checks[0]?.findings[0];
    expect(finding && 'metadata' in finding).toBe(false);
  });
});

describe('renderJson', () => {
  it('returns indented JSON of the CliOutput', () => {
    const json = renderJson([signal()], { cwd: '/x', tool: 'graph', command: 'graph' });
    const parsed = JSON.parse(json) as CliOutput;
    expect(parsed.tool).toBe('graph');
    expect(parsed.checks).toHaveLength(1);
    // Pretty-printed (two-space indent).
    expect(json).toContain('\n  "tool"');
  });
});

function finding(over: Partial<FindingOutput> = {}): FindingOutput {
  return {
    ruleId: 'graph.cycle',
    message: 'cyclic',
    severity: 'warning',
    filePath: 'src/b.ts',
    ...over,
  };
}

describe('buildCliOutputFromFindings', () => {
  it('trusts pre-normalized severities and carries duration through', () => {
    const out = buildCliOutputFromFindings(
      [
        finding({ ruleId: 'r1', severity: 'error' }),
        finding({ ruleId: 'r1', severity: 'warning' }),
        finding({ ruleId: 'r2', severity: 'warning' }),
      ],
      'graph',
      42,
    );
    expect(out.durationMs).toBe(42);
    expect(out.checks).toHaveLength(2);
    const r1 = out.checks.find((c) => c.checkSlug === 'r1');
    expect(r1?.passed).toBe(false);
    expect(r1?.violationCount).toBe(2);
    expect(out.summary.errors).toBe(1);
    expect(out.summary.warnings).toBe(2);
    expect(out.passed).toBe(false);
  });

  it('scores a warnings-only aggregate as fully passed', () => {
    const out = buildCliOutputFromFindings([finding()], 'graph', 0);
    expect(out.passed).toBe(true);
    expect(out.score).toBe(100);
  });
});
