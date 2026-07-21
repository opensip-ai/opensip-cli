/**
 * Regression: graph's session contribution must record a row for EVERY rule the
 * run evaluated — so a CLEAN run still shows the full rule list in the report's
 * session detail (parity with fitness), not an empty "no results" panel.
 *
 * The bug this guards: contribution assembly was duplicated across the static
 * `executeGraph` dispatch and the live Ink runner. The static path threaded the
 * evaluated rule set into the payload; the live (interactive) path called the
 * payload builder with NO rule set, so a clean interactive run persisted an
 * empty `checks[]` and the report rendered nothing. Both paths now route through
 * the single exported `contributionFromSignals`, whose `evaluatedSlugs` param
 * DEFAULTS to the scope's full registry (never the empty set) — so a caller that
 * forgets to pass rules still records the rule list rather than reproducing the
 * bug.
 *
 * ADR-0177: session score/passed MUST copy buildGraphEnvelope(...).verdict, not
 * passRate of the all-evaluated payload summary. One high-severity finding +
 * several clean evaluated rules is the fails-on-main shape (live ~0%, old
 * session ~80%).
 */

import { passRate } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { buildGraphEnvelope } from '../../cli/build-envelope.js';
import { contributionFromSignals, evaluatedRuleSlugs } from '../../cli/graph.js';
import { withGraphScopeSync } from '../test-utils/with-graph-scope.js';

import type { GraphSessionPayload } from '../../persistence/session-payload.js';
import type { Signal, SignalSeverity } from '@opensip-cli/core';

function sig(over: {
  ruleId: string;
  severity: SignalSeverity;
  filePath: string;
  line?: number;
}): Signal {
  return {
    id: `sig_${over.ruleId}_${String(over.line ?? 0)}`,
    source: 'graph',
    provider: 'opensip-cli',
    severity: over.severity,
    category: 'quality',
    ruleId: over.ruleId,
    message: 'finding',
    filePath: over.filePath,
    line: over.line,
    metadata: {},
    createdAt: '2026-06-15T00:00:00.000Z',
  };
}

describe('contributionFromSignals', () => {
  it('records a PASS row per evaluated rule on a CLEAN run (explicit rule set — the live-path scenario)', () => {
    const evaluated = ['graph:large-function', 'graph:cycle', 'graph:dup-body'];
    const contribution = contributionFromSignals({ cwd: '/repo' }, [], evaluated);
    const payload = contribution.payload as GraphSessionPayload;

    expect(contribution.tool).toBe('graph');
    expect(contribution.passed).toBe(true);
    expect(contribution.score).toBe(100);
    // Every evaluated rule becomes a PASS row — not an empty table.
    expect(payload.checks).toHaveLength(evaluated.length);
    expect(payload.checks.every((c) => c.passed && c.violationCount === 0)).toBe(true);
    expect(payload.checks.map((c) => c.checkSlug).sort()).toEqual([...evaluated].sort());
    expect(payload.summary).toEqual({
      total: 3,
      passed: 3,
      failed: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it('marks the rule that fired as failed while keeping the clean ones as PASS rows', () => {
    const contribution = contributionFromSignals(
      { cwd: '/repo', recipe: 'default' },
      [
        sig({
          ruleId: 'graph:cycle',
          severity: 'high',
          filePath: 'a.ts',
          line: 1,
        }),
      ],
      ['graph:cycle', 'graph:large-function'],
    );
    const payload = contribution.payload as GraphSessionPayload;
    expect(contribution.recipe).toBe('default');
    expect(contribution.passed).toBe(false);
    expect(payload.checks.find((c) => c.checkSlug === 'graph:cycle')?.passed).toBe(false);
    expect(payload.checks.find((c) => c.checkSlug === 'graph:large-function')?.passed).toBe(true);
  });

  it('DEFAULTS the evaluated set to the scope registry — a caller that omits rules still records the full list (structural guard)', () => {
    // No explicit rule set AND no signals: the old bug's exact shape. The default
    // must come from the scope's rule registry, so the contribution still lists
    // every built-in rule as a PASS row instead of an empty table.
    const { payload, allSlugs } = withGraphScopeSync(() => {
      const contribution = contributionFromSignals({ cwd: '/repo' }, []);
      return {
        payload: contribution.payload as GraphSessionPayload,
        allSlugs: evaluatedRuleSlugs(),
      };
    });
    expect(allSlugs.length).toBeGreaterThan(0);
    expect(payload.checks).toHaveLength(allSlugs.length);
    expect(payload.checks.every((c) => c.passed)).toBe(true);
    expect(payload.checks.every((c) => c.checkSlug.startsWith('graph:'))).toBe(true);
  });

  it('ADR-0177: score/passed copy envelope.verdict, not passRate of all-evaluated summary (fails on main concept)', () => {
    // One high-severity finding + four clean evaluated rules.
    // Envelope units are per fired rule only → score 0, passed false.
    // All-evaluated payload summary → passRate ~80 — the old session bug.
    const signals = [
      sig({
        ruleId: 'graph:cycle',
        severity: 'high',
        filePath: 'a.ts',
        line: 1,
      }),
    ];
    const evaluated = [
      'graph:cycle',
      'graph:large-function',
      'graph:wide-function',
      'graph:high-blast-untested',
      'graph:duplicated-function-body',
    ];

    const contribution = contributionFromSignals({ cwd: '/repo' }, signals, evaluated);
    const payload = contribution.payload as GraphSessionPayload;
    const envelope = buildGraphEnvelope({
      signals,
      runId: '',
      createdAt: '',
    });

    // Clean-rule inventory remains in payload detail.
    expect(payload.checks).toHaveLength(evaluated.length);
    expect(payload.summary.total).toBe(5);
    expect(payload.summary.passed).toBe(4);
    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.errors).toBe(1);

    // The diverging "main" concept: passRate of all-evaluated summary is ~80.
    const inflatedScore = passRate(payload.summary);
    expect(inflatedScore).toBe(80);
    expect(envelope.verdict.score).toBe(0);
    expect(envelope.verdict.passed).toBe(false);

    // Session must match envelope (live delivery), not the inflated inventory rate.
    expect(contribution.score).toBe(envelope.verdict.score);
    expect(contribution.passed).toBe(envelope.verdict.passed);
    expect(contribution.score).not.toBe(inflatedScore);
    expect(contribution.score).toBe(0);
    expect(contribution.passed).toBe(false);
    expect(contribution.runOutcome).toBe('failed');
  });
});

describe('evaluatedRuleSlugs', () => {
  it('returns the explicit rule set when provided (the live runner forwards args.rules)', () => {
    expect(
      evaluatedRuleSlugs([
        { slug: 'graph:cycle' } as never,
        { slug: 'graph:wide-function' } as never,
      ]),
    ).toEqual(['graph:cycle', 'graph:wide-function']);
  });

  it('reads the scope registry when no explicit set is given', () => {
    const slugs = withGraphScopeSync(() => evaluatedRuleSlugs());
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.every((s) => s.startsWith('graph:'))).toBe(true);
  });

  it('degrades to the empty set outside a graph scope (isolated dispatch unit test)', () => {
    expect(evaluatedRuleSlugs()).toEqual([]);
  });
});
