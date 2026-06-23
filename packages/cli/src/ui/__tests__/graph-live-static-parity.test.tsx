/**
 * Graph live/static parity — the verbose table proof.
 *
 * Graph's STATIC render path routes through the host's `envelopeToTableView`
 * (`result-to-view.ts`) when a verbose/detail view asks for the table. To keep
 * the LIVE verbose final frame in parity, graph's live runner renders its OWN
 * per-unit table (`liveRunTable` + `envelopeToLiveRunTableRows`,
 * `@opensip-cli/graph/internal`) — it cannot import the host's `envelopeTableNode`
 * (cli) nor `@opensip-cli/output` (forbidden to tool engines). This test pins the
 * two against each other: for the same graph envelope, the live table node and the
 * static detail table must render to IDENTICAL content (TTY + pipe), so the two
 * derivations cannot drift.
 *
 * The static `envelopeToTableView` also renders the summary line; graph's live
 * frame renders the summary via the shared `<RunSummary>` (already reconciled with
 * the static `viewRunSummary` producer). So we compare the TABLE rows only —
 * extracting the lines above the summary — which is exactly the surface
 * `liveRunTable` owns.
 */

import { liveRunTable, renderToText, renderToInk, ThemeProvider } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { envelopeToLiveRunTableRows } from '@opensip-cli/graph/internal';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { envelopeToTableView } from '../result-to-view.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function graphSignal(over: {
  source: string;
  severity: Signal['severity'];
  message: string;
  filePath: string;
  line?: number;
}): Signal {
  return {
    id: `sig_${over.source}_${String(over.line ?? 0)}`,
    source: over.source,
    provider: 'opensip-cli',
    severity: over.severity,
    category: 'architecture',
    ruleId: over.source,
    message: over.message,
    filePath: over.filePath,
    line: over.line,
    metadata: {},
    createdAt: CREATED_AT,
  };
}

/**
 * A graph-shaped envelope: one unit per rule that fired, every unit stamped
 * `durationMs: 0` (graph's real shape — `build-envelope.ts`). A mix of a failing
 * (error-severity) rule and a clean rule so the sort + tones exercise both rungs.
 */
function graphEnvelope(): SignalEnvelope {
  return buildSignalEnvelope({
    tool: 'graph',
    runId: 'run-1',
    createdAt: CREATED_AT,
    units: [
      { slug: 'graph.dead-code.orphan-subtree', passed: true, violationCount: 2, durationMs: 0 },
      { slug: 'graph.architecture.cycle', passed: false, violationCount: 1, durationMs: 0 },
    ],
    signals: [
      graphSignal({
        source: 'graph.dead-code.orphan-subtree',
        severity: 'medium',
        message: 'orphan',
        filePath: 'src/a.ts',
        line: 1,
      }),
      graphSignal({
        source: 'graph.dead-code.orphan-subtree',
        severity: 'low',
        message: 'orphan',
        filePath: 'src/b.ts',
        line: 2,
      }),
      graphSignal({
        source: 'graph.architecture.cycle',
        severity: 'high',
        message: 'cycle',
        filePath: 'src/c.ts',
        line: 3,
      }),
    ],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

/** Strip ANSI so a TTY frame compares to the pipe text. */
function deAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- strip ANSI color sequences from the Ink frame
  return s.replaceAll(/\[[0-9;]*m/g, '');
}

/**
 * The table rows the static `envelopeToTableView` renders, isolated from the
 * trailing summary line. The summary always contains "Duration"; everything
 * above the line beginning with PASS/FAIL is the table (header + separator +
 * rows). We keep non-empty table lines.
 */
function staticTableLines(envelope: SignalEnvelope): string[] {
  const text = deAnsi(renderToText(envelopeToTableView(envelope)));
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !/^(PASS|FAIL)\b/.test(l.trim()));
}

function liveTableLines(envelope: SignalEnvelope): string[] {
  const node = liveRunTable(envelopeToLiveRunTableRows(envelope));
  expect(node).not.toBeNull();
  const text = deAnsi(renderToText(node!));
  return text.split('\n').filter((l) => l.trim().length > 0);
}

describe('graph live/static verbose table parity', () => {
  it('the live table node renders the SAME per-unit table the static detail path does (pipe)', () => {
    const envelope = graphEnvelope();
    expect(liveTableLines(envelope)).toEqual(staticTableLines(envelope));
  });

  it('the live table node TTY frame matches its pipe text (no renderer drift)', () => {
    const envelope = graphEnvelope();
    const node = liveRunTable(envelopeToLiveRunTableRows(envelope));
    expect(node).not.toBeNull();
    const { lastFrame } = render(<ThemeProvider>{renderToInk(node!)}</ThemeProvider>);
    const ttyLines = deAnsi(lastFrame() ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    const pipeLines = liveTableLines(envelope).map((l) => l.trimEnd());
    expect(ttyLines).toEqual(pipeLines);
  });

  it('renders null for an empty envelope (no rule fired)', () => {
    const empty = buildSignalEnvelope({
      tool: 'graph',
      runId: 'r',
      createdAt: CREATED_AT,
      units: [],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    });
    expect(liveRunTable(envelopeToLiveRunTableRows(empty))).toBeNull();
  });
});
