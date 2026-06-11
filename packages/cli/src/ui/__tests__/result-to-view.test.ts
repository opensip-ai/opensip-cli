import { renderToText } from '@opensip-tools/cli-ui';
import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult, SimDoneResult } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

function textOf(result: CommandResult): string {
  return renderToText(resultToView(result));
}

/** Build a fit signal for the table-derivation tests (`source === ruleId === checkSlug`). */
function fitSignal(over: {
  source: string;
  severity: Signal['severity'];
  message?: string;
  filePath?: string;
  line?: number;
}): Signal {
  return {
    id: `sig_${over.source}_${String(over.line ?? 0)}`,
    source: over.source,
    provider: 'opensip-tools',
    severity: over.severity,
    category: 'quality',
    ruleId: over.source,
    message: over.message ?? 'm',
    filePath: over.filePath ?? 'a.ts',
    line: over.line,
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
  };
}

describe('resultToView', () => {
  it('renders fit-done from the envelope: table (with Validated/Ignores), summary', () => {
    // ADR-0011 Phase 6: fitness is migrated — the fit-done table is derived
    // from the envelope's units + signals (one row per check unit), including
    // the fitness-only Validated/Ignores columns carried on UnitResult.
    const out = textOf({
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
          fitSignal({
            source: 'no-console',
            severity: 'high',
            message: 'console.log',
            filePath: 'a.ts',
            line: 3,
          }),
          fitSignal({
            source: 'no-console',
            severity: 'high',
            message: 'console.log',
            filePath: 'b.ts',
            line: 4,
          }),
          fitSignal({ source: 'naming', severity: 'medium', message: 'bad name' }),
        ],
      }),
    });
    // Table: FAIL sorts above PASS, header + the fitness columns present.
    expect(out).toContain('Unit');
    expect(out).toContain('Status');
    expect(out).toContain('Validated');
    expect(out).toContain('Ignores');
    expect(out).toContain('10 files');
    expect(out.indexOf('no-console')).toBeLessThan(out.indexOf('naming')); // FAIL before PASS
    // Shared summary line (1 passed, 1 failed; 2 errors, 1 warning).
    expect(out).toContain('1 Passed, 1 Failed (2 Errors, 1 Warnings) | Duration 8ms');
  });

  it('renders the fit-done verbose findings body and suppresses the hint (ADR-0021)', () => {
    const out = textOf({
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [{ slug: 'no-console', passed: false, durationMs: 5 }],
        signals: [
          fitSignal({
            source: 'no-console',
            severity: 'high',
            message: 'console.log',
            filePath: 'a.ts',
            line: 3,
          }),
        ],
      }),
      verboseDetail: {
        kind: 'findings',
        groups: [
          {
            title: 'No Console',
            errorCount: 1,
            warningCount: 0,
            findings: [{ severity: 'error', message: 'console.log', location: 'a.ts:3' }],
          },
        ],
      },
    });
    expect(out).toContain('Findings');
    expect(out).toContain('No Console');
    expect(out).toContain('console.log');
    expect(out).toContain('a.ts:3');
    // Verbose run: no "Use --verbose…" hint.
    expect(out).not.toContain('Use --verbose for detailed results');
  });

  it('shows the shared "Use --verbose…" hint on a non-verbose fit-done run (ADR-0021)', () => {
    const out = textOf({
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [{ slug: 'naming', passed: true, durationMs: 3 }],
        signals: [],
      }),
    });
    expect(out).toContain('Use --verbose for detailed results');
    expect(out).toContain('opensip-tools dashboard for HTML report');
  });

  it('renders fit-done errored/clean units: ERROR status, blank validated cell', () => {
    const out = textOf({
      type: 'fit-done',
      label: 'fit',
      cwd: '/x',
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [
          { slug: 'loader', passed: false, durationMs: 1, error: 'failed to load' },
          {
            slug: 'naming',
            passed: false,
            durationMs: 2,
            filesValidated: 5,
            itemType: 'files',
            ignoredCount: 3,
          },
        ],
        signals: [
          fitSignal({ source: 'naming', severity: 'medium', message: 'w0', filePath: 'b.ts' }),
        ],
      }),
    });
    expect(out).toContain('ERROR'); // errored unit status
    expect(out).toContain('loader');
    expect(out).toContain('—'); // loader has no validated count → blank cell
  });

  it('renders help and list views (every result type is now total)', () => {
    expect(renderToText(resultToView({ type: 'help' }))).toContain('Codebase analysis toolkit');
    expect(
      renderToText(
        resultToView({
          type: 'list-recipes',
          recipes: [{ name: 'example', description: 'demo', checkCount: '3 checks' }],
        }),
      ),
    ).toContain('example');
  });

  it('renders generic text-lines command results', () => {
    const out = textOf({ type: 'text-lines', title: 'Custom Tool', lines: ['alpha', 'beta'] });

    expect(out).toContain('Custom Tool');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('renders an unsupported result type as a diagnostic instead of blank output', () => {
    const out = renderToText(
      resultToView({ type: 'custom-tool-result' } as unknown as CommandResult),
    );

    expect(out).toContain("Unsupported command result 'custom-tool-result'");
    expect(out).toContain('Use --json');
  });

  it('renders an error with the ✗ marker and indented suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', suggestion: 'try --help', exitCode: 1 });
    expect(out).toBe('  ✗ boom\n      try --help');
  });

  it('renders an error without a suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', exitCode: 1 });
    expect(out).toBe('  ✗ boom');
  });

  // ADR-0011 (Phase 4): sim is migrated — the sim-done view is derived from
  // the envelope's per-unit table (one row per scenario), not the retired
  // per-scenario `simDoneView`. Scenario `a` passed; scenario `b` failed an
  // assertion (emitting a `high` signal sourced at its scenarioId).
  const bSignal: Signal = {
    id: 'sig_b1',
    source: 'b',
    provider: 'opensip-tools',
    severity: 'high',
    category: 'resilience',
    ruleId: 'invariant.violated',
    message: 'invariant broke',
    filePath: '',
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
  };
  const simBase: SimDoneResult = {
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
        { slug: 'b', passed: false, durationMs: 20 },
      ],
      signals: [bSignal],
    }),
  };

  it('renders the sim-done table and summary from the envelope', () => {
    const out = textOf(simBase);
    // One row per scenario-unit, keyed by scenarioId; b's high signal counts
    // as an error on its row and drives the FAIL status.
    expect(out).toContain('Unit');
    expect(out).toContain('Status');
    expect(out).toContain('a');
    expect(out).toContain('b');
    // Shared run summary: 1 passed, 1 failed, 1 error.
    expect(out).toContain('1 Passed, 1 Failed (1 Errors, 0 Warnings)');
  });

  it('renders the empty-scenarios sim-done shape (no table, zeroed summary)', () => {
    const out = textOf({
      ...simBase,
      shouldFail: false,
      envelope: buildSignalEnvelope({
        tool: 'sim',
        recipe: 'example',
        runId: 'run-1',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [],
        signals: [],
      }),
    });
    expect(out).toContain('0 Passed, 0 Failed (0 Errors, 0 Warnings)');
  });

  it('renders graph-done summary + footer via the shared producers (no banner text)', () => {
    // Non-verbose: no verboseDetail; the seam emits the shared "Use --verbose…"
    // hint + graph's dashboard hint (ADR-0021).
    const out = textOf({
      type: 'graph-done',
      summary: { passed: 3, failed: 0, errors: 0, warnings: 0 },
      durationMs: 1200,
    });
    expect(out).toContain('3 Passed, 0 Failed (0 Errors, 0 Warnings) | Duration 1.2s');
    expect(out).toContain('  Use --verbose for detailed results');
    expect(out).toContain('opensip-tools dashboard for HTML report');
  });

  it('renders gate-done lines verbatim', () => {
    const out = textOf({
      type: 'gate-done',
      lines: ['opensip-tools gate compare', '', '✓ STABLE — no change'],
    });
    expect(out).toBe('opensip-tools gate compare\n\n✓ STABLE — no change');
  });

  it('renders the graph-done verbose body and fast-tier caveat', () => {
    // Verbose: the body rides on verboseDetail{kind:'lines'} (ADR-0021); the
    // seam renders it and suppresses the footer hints.
    const out = textOf({
      type: 'graph-done',
      verboseDetail: {
        kind: 'lines',
        lines: ['== Catalog ==', '5 functions across 2 files (cacheHit=false)'],
      },
      resolutionBanner: 'Resolution: fast (syntactic) — edges are approximate.',
      summary: { passed: 1, failed: 1, errors: 0, warnings: 0 },
      durationMs: 50,
    });
    expect(out).toContain('== Catalog ==');
    expect(out).toContain('5 functions across 2 files');
    expect(out).toContain('Resolution: fast (syntactic)');
    expect(out).toContain('1 Passed, 1 Failed');
    expect(out).not.toContain('Use --verbose for detailed results');
  });
});
