/**
 * Cross-renderer equivalence — the non-drift proof.
 *
 * For each representative result type, the SAME view-model node
 * (resultToView output) is rendered through both interpreters:
 * renderToInk (TTY, via ink-testing-library) and renderToText (pipe/CI).
 * The visible content must match. Because Ink wraps at the virtual
 * terminal width while renderToText does not, we compare with whitespace
 * collapsed — this ignores wrap points and indentation but still catches
 * any real content drift (missing / extra / reordered / changed tokens),
 * which is exactly what "the two renderers can't diverge" must guarantee.
 */

import { renderToText, renderToInk, ThemeProvider } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult } from '@opensip-cli/contracts';

/** Collapse all whitespace so wrapping/indentation differences are ignored. */
function normalize(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- strip ANSI color sequences from the Ink frame
      .replaceAll(/\[[0-9;]*m/g, '')
      .replaceAll(/-{2,}/g, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
  );
}

function inkText(result: CommandResult): string {
  const { lastFrame } = render(<ThemeProvider>{renderToInk(resultToView(result))}</ThemeProvider>);
  return normalize(lastFrame() ?? '');
}

function plainText(result: CommandResult): string {
  return normalize(renderToText(resultToView(result)));
}

const FIXTURES: Readonly<Record<string, CommandResult>> = {
  error: { type: 'error', message: 'boom', suggestion: 'try --help', exitCode: 1 },
  // ADR-0011 (Phase 4): sim is now envelope-derived (one unit row per scenario),
  // rendered through the shared envelopeToTableView like fit/graph, via a
  // RunPresentation (envelope-first-presentation plan).
  'sim-run': {
    type: 'run-presentation',
    tool: 'simulation',
    envelope: buildSignalEnvelope({
      tool: 'sim',
      recipe: 'example',
      runId: 'run-1',
      createdAt: '2026-06-04T00:00:00.000Z',
      units: [
        { slug: 'a', passed: true, durationMs: 10 },
        { slug: 'b', passed: false, durationMs: 20, error: 'broke' },
      ],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    }),
  },
  // RP-2: graph renders the envelope-backed RunPresentation — compact verdict
  // summary by default, with the resolution caveat as a muted banner.
  'graph-run': {
    type: 'run-presentation',
    tool: 'graph',
    banners: ['Resolution: fast (syntactic) — edges are approximate.'],
    durationMs: 1200,
    envelope: buildSignalEnvelope({
      tool: 'graph',
      runId: 'run-1',
      createdAt: '2026-06-04T00:00:00.000Z',
      units: [
        { slug: 'graph.architecture.cycle', passed: true, violationCount: 0, durationMs: 0 },
        { slug: 'graph.dead-code.orphan-subtree', passed: false, violationCount: 1, durationMs: 0 },
      ],
      signals: [
        {
          id: 'g1',
          source: 'graph.dead-code.orphan-subtree',
          provider: 'opensip-cli',
          severity: 'medium',
          category: 'architecture',
          ruleId: 'graph.dead-code.orphan-subtree',
          message: 'orphan',
          filePath: 'src/a.ts',
          line: 1,
          metadata: {},
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    }),
  },
  'gate-done': {
    type: 'gate-done',
    lines: ['opensip gate compare', '', '✓ STABLE — no change'],
  },
  'graph-status': {
    type: 'graph-status',
    lines: ['saveBaseline — 1 occurrence(s)', '  saveBaseline (function)', '    src/gate.ts:12:0'],
  },
  // ADR-0011 Phase 6: fit is envelope-derived (one row per check unit, with the
  // fitness Validated/Ignores columns from UnitResult), via a RunPresentation.
  'fit-run': {
    type: 'run-presentation',
    tool: 'fitness',
    envelope: buildSignalEnvelope({
      tool: 'fit',
      runId: 'r',
      createdAt: '2026-06-04T00:00:00.000Z',
      units: [
        {
          slug: 'no-console',
          passed: false,
          durationMs: 5,
          filesValidated: 10,
          itemType: 'files',
          ignoredCount: 0,
        },
        {
          slug: 'naming',
          passed: true,
          durationMs: 3,
          filesValidated: 10,
          itemType: 'files',
          ignoredCount: 0,
        },
      ],
      signals: [
        {
          id: 's1',
          source: 'no-console',
          provider: 'opensip-cli',
          severity: 'high',
          category: 'quality',
          ruleId: 'no-console',
          message: 'console.log',
          filePath: 'a.ts',
          line: 3,
          metadata: {},
          createdAt: '2026-06-04T00:00:00.000Z',
        },
        {
          id: 's2',
          source: 'no-console',
          provider: 'opensip-cli',
          severity: 'high',
          category: 'quality',
          ruleId: 'no-console',
          message: 'console.log',
          filePath: 'b.ts',
          line: 4,
          metadata: {},
          createdAt: '2026-06-04T00:00:00.000Z',
        },
        {
          id: 's3',
          source: 'naming',
          provider: 'opensip-cli',
          severity: 'medium',
          category: 'quality',
          ruleId: 'naming',
          message: 'bad name',
          filePath: 'c.ts',
          metadata: {},
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    }),
  },
};

describe('cross-renderer equivalence (Ink === plain text content)', () => {
  it.each(Object.keys(FIXTURES))('renders identical content for %s in both renderers', (key) => {
    const fixture = FIXTURES[key];
    expect(inkText(fixture)).toBe(plainText(fixture));
  });

  it('fails loudly if a view producer drifts between the renderers', () => {
    // Sanity check on the guard itself: two different views must NOT compare equal.
    expect(plainText(FIXTURES.error)).not.toBe(plainText(FIXTURES['gate-done']));
  });
});
