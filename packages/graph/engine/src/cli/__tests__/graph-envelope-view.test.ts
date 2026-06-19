import { renderToText } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { graphDoneTableNode } from '../graph-envelope-view.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function graphSignal(overrides: {
  readonly source: string;
  readonly severity: Signal['severity'];
  readonly message: string;
  readonly line: number;
}): Signal {
  return {
    id: `sig_${overrides.source}_${String(overrides.line)}`,
    source: overrides.source,
    provider: 'opensip-cli',
    severity: overrides.severity,
    category: 'architecture',
    ruleId: overrides.source,
    message: overrides.message,
    filePath: `src/${overrides.source}.ts`,
    line: overrides.line,
    metadata: {},
    createdAt: CREATED_AT,
  };
}

function envelope(): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'graph',
    runId: 'run-1',
    createdAt: CREATED_AT,
    units: [
      {
        slug: 'graph.clean.pass',
        passed: true,
        violationCount: 0,
        durationMs: 0,
      },
      {
        slug: 'graph.slow.warning',
        passed: false,
        violationCount: 2,
        durationMs: 31_000,
      },
      {
        slug: 'graph.unit.error',
        passed: false,
        violationCount: 1,
        durationMs: 61_000,
        error: 'rule crashed',
      },
    ],
    signals: [
      graphSignal({
        source: 'graph.slow.warning',
        severity: 'high',
        message: 'high severity finding',
        line: 1,
      }),
      graphSignal({
        source: 'graph.slow.warning',
        severity: 'medium',
        message: 'medium severity finding',
        line: 2,
      }),
      graphSignal({
        source: 'graph.clean.pass',
        severity: 'low',
        message: 'low severity advisory',
        line: 3,
      }),
    ],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

describe('graphDoneTableNode', () => {
  it('renders the graph unit table derived from the signal envelope', () => {
    const node = graphDoneTableNode(envelope());

    expect(node).not.toBeNull();
    expect(renderToText(node!)).toMatchInlineSnapshot(`
      "Unit                                     | Status  | Errors | Warnings | Duration  
      -----------------------------------------|---------|--------|----------|-----------
      graph.unit.error                         | ERROR   | 0      | 0        | 1m 1.0s   
      graph.slow.warning                       | FAIL    | 1      | 1        | 31.0s     
      graph.clean.pass                         | PASS    | 0      | 1        | 0ms       "
    `);
  });

  it('renders null when no graph units fired', () => {
    const empty = buildSignalEnvelope({
      tool: 'graph',
      runId: 'run-empty',
      createdAt: CREATED_AT,
      units: [],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    });

    expect(graphDoneTableNode(empty)).toBeNull();
  });
});
