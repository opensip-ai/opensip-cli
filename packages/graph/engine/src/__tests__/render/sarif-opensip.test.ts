/**
 * Golden-fixture tests for the OpenSIP SARIF emitter.
 *
 * Phase 2 Task 2.3 (DEC-498). Locks the SARIF wire format for each of
 * the five built-in engine rules. A change to the emitter's output for
 * any rule breaks the matching fixture; intentional changes are
 * recorded by deleting + regenerating the fixture file.
 *
 * Coverage invariants beyond per-rule equality:
 *   1. `tool.driver.name === 'opensip-tools-graph'` for every emission.
 *   2. Every `result.ruleId` matches the OpenSIP-convention regex
 *      (`graph.<family>.<rule>`).
 *
 * Fixtures are written via Vitest's `toMatchFileSnapshot`. First run
 * generates the file; subsequent runs assert byte-for-byte equality.
 * Regenerate after intentional changes by deleting the file and
 * running the test once.
 */

import { describe, expect, it } from 'vitest';

import { OPENSIP_RULE_ID_REGEX } from '../../render/rule-id-mapping.js';
import { renderSarifOpenSip } from '../../render/sarif-opensip.js';

import type { Signal, SignalSeverity } from '@opensip-tools/core';

const CONTEXT = { tool: 'opensip-tools-graph', toolVersion: '2.0.0' };

interface RuleFixture {
  readonly slug: string;
  readonly severity: SignalSeverity;
  readonly message: string;
  readonly filePath: string;
  readonly line: number;
  readonly column?: number;
}

const RULE_FIXTURES: readonly RuleFixture[] = [
  {
    slug: 'graph:orphan-subtree',
    severity: 'medium',
    message: "Function 'processOrder' appears unreachable from any entry point.",
    filePath: 'src/order/process.ts',
    line: 42,
  },
  {
    slug: 'graph:duplicated-function-body',
    severity: 'low',
    message: "Function 'formatDate' has the same body as 3 other functions.",
    filePath: 'src/utils/format.ts',
    line: 8,
  },
  {
    slug: 'graph:no-side-effect-path',
    severity: 'medium',
    message: "Function 'computeMetrics' return value is never consumed.",
    filePath: 'src/metrics/compute.ts',
    line: 23,
  },
  {
    slug: 'graph:always-throws-branch',
    severity: 'critical',
    message: "Branch in 'handleError' always throws.",
    filePath: 'src/error/handler.ts',
    line: 67,
  },
  {
    slug: 'graph:test-only-reachable',
    severity: 'low',
    message: "Function 'mockUser' is only reachable from test files.",
    filePath: 'src/users/mock.ts',
    line: 5,
  },
];

function makeSignal(fixture: RuleFixture): Signal {
  return {
    id: `sig_${fixture.slug.replace('graph:', '').replaceAll('-', '_')}`,
    source: 'graph',
    provider: 'opensip-tools',
    severity: fixture.severity,
    category: 'quality',
    ruleId: fixture.slug,
    message: fixture.message,
    filePath: fixture.filePath,
    line: fixture.line,
    column: fixture.column,
    code: { file: fixture.filePath, line: fixture.line, column: fixture.column },
    metadata: {},
    createdAt: '2026-05-27T00:00:00.000Z',
  };
}

describe('renderSarifOpenSip — golden fixtures', () => {
  for (const fixture of RULE_FIXTURES) {
    const ruleSlug = fixture.slug.replace('graph:', '');

    it(`matches fixture for ${fixture.slug}`, async () => {
      const sarif = renderSarifOpenSip([makeSignal(fixture)], CONTEXT);
      await expect(sarif).toMatchFileSnapshot(
        `./__fixtures__/sarif/${ruleSlug}.json`,
      );
    });
  }
});

describe('renderSarifOpenSip — invariants', () => {
  it('every result.ruleId matches the OpenSIP rule-ID regex', () => {
    const signals = RULE_FIXTURES.map(makeSignal);
    const parsed = JSON.parse(renderSarifOpenSip(signals, CONTEXT)) as {
      runs: { results: { ruleId: string }[] }[];
    };
    expect(parsed.runs[0].results.length).toBe(RULE_FIXTURES.length);
    for (const result of parsed.runs[0].results) {
      expect(result.ruleId).toMatch(OPENSIP_RULE_ID_REGEX);
    }
  });

  it('tool.driver.name is opensip-tools-graph', () => {
    const sarif = renderSarifOpenSip(RULE_FIXTURES.map(makeSignal), CONTEXT);
    const parsed = JSON.parse(sarif) as {
      runs: { tool: { driver: { name: string; version: string } } }[];
    };
    expect(parsed.runs[0].tool.driver.name).toBe('opensip-tools-graph');
    expect(parsed.runs[0].tool.driver.version).toBe('2.0.0');
  });

  it('tool.driver.rules contains every OpenSIP rule ID emitted in results', () => {
    const sarif = renderSarifOpenSip(RULE_FIXTURES.map(makeSignal), CONTEXT);
    const parsed = JSON.parse(sarif) as {
      runs: {
        tool: { driver: { rules: { id: string }[] } };
        results: { ruleId: string }[];
      }[];
    };
    const driverRuleIds = new Set(parsed.runs[0].tool.driver.rules.map((r) => r.id));
    for (const result of parsed.runs[0].results) {
      expect(driverRuleIds.has(result.ruleId)).toBe(true);
    }
    expect(driverRuleIds.size).toBe(RULE_FIXTURES.length);
  });
});
