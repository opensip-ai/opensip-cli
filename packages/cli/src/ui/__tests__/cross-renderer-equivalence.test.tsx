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

import { renderToText, renderToInk, ThemeProvider } from '@opensip-tools/cli-ui';
import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-tools/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult } from '@opensip-tools/contracts';

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
  // ADR-0011 (Phase 4): sim-done is now envelope-derived (one unit row per
  // scenario), rendered through the shared envelopeToTableView like fit/graph.
  'sim-done': {
    type: 'sim-done',
    recipeName: 'example',
    cwd: '/x',
    durationMs: 1500,
    shouldFail: true,
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
  'graph-done': {
    type: 'graph-done',
    reportLines: ['== Catalog ==', '5 functions across 2 files (cacheHit=false)'],
    resolutionBanner: 'Resolution: fast (syntactic) — edges are approximate.',
    summary: { passed: 1, failed: 1, errors: 0, warnings: 3 },
    durationMs: 1200,
    footerHints: [{ text: 'Use --verbose for detailed results', bold: ['--verbose'] }],
  },
  'gate-done': {
    type: 'gate-done',
    lines: ['opensip-tools gate compare', '', '✓ STABLE — no change'],
  },
  'graph-status': {
    type: 'graph-status',
    lines: ['saveBaseline — 1 occurrence(s)', '  saveBaseline (function)', '    src/gate.ts:12:0'],
  },
  // ADR-0011 Phase 6: fit-done is envelope-derived (one row per check unit,
  // with the fitness Validated/Ignores columns from UnitResult).
  'fit-done': {
    type: 'fit-done',
    label: 'fit',
    cwd: '/x',
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
          provider: 'opensip-tools',
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
          provider: 'opensip-tools',
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
          provider: 'opensip-tools',
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
