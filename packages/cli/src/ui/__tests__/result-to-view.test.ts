import { renderToText } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult, RunPresentation } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

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
    provider: 'opensip-cli',
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
  it('renders a non-verbose fit RunPresentation as summary + footer, without the detailed table', () => {
    const out = textOf({
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
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
    });
    expect(out).not.toContain('Unit');
    expect(out).not.toContain('Status');
    expect(out).not.toContain('Validated');
    expect(out).not.toContain('no-console');
    expect(out).not.toContain('naming');
    expect(out).toContain('FAIL  (2 Errors, 1 Warnings) | Duration 8ms');
    expect(out).toContain('Use --verbose for detailed results');
  });

  it('renders the fit verbose findings body + detailed table and suppresses the hint (ADR-0021)', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'fitness',
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
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
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
    expect(out).toContain('Unit');
    expect(out).toContain('Status');
    expect(out).toContain('no-console');
    // Verbose run: no "Use --verbose…" hint.
    expect(out).not.toContain('Use --verbose for detailed results');
  });

  it('shows the shared "Use --verbose…" hint on a non-verbose fit run (ADR-0021)', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'fitness',
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [{ slug: 'naming', passed: true, durationMs: 3 }],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
    });
    expect(out).toContain('Use --verbose for detailed results');
    expect(out).toContain('opensip report for HTML report');
  });

  it('renders a verbose fit table with errored/clean units: ERROR status, blank validated cell', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'fitness',
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
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
      verboseDetail: { kind: 'findings', groups: [] },
    });
    expect(out).toContain('ERROR'); // errored unit status
    expect(out).toContain('loader');
    expect(out).toContain('—'); // loader has no validated count → blank cell
  });

  it('renders validated/ignored columns across ignored-ratio thresholds', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'fitness',
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [
          {
            slug: 'ignored.none',
            passed: true,
            durationMs: 1,
            filesValidated: 10,
            itemType: 'files',
            ignoredCount: 0,
          },
          {
            slug: 'ignored.warning',
            passed: true,
            durationMs: 2,
            filesValidated: 10,
            itemType: 'files',
            ignoredCount: 1,
          },
          {
            slug: 'ignored.error',
            passed: true,
            durationMs: 3,
            filesValidated: 10,
            itemType: 'files',
            ignoredCount: 2,
          },
        ],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
      verboseDetail: { kind: 'findings', groups: [] },
    });

    expect(out).toContain('Validated');
    expect(out).toContain('Ignores');
    expect(out).toContain('ignored.none');
    expect(out).toContain('ignored.warning');
    expect(out).toContain('ignored.error');
  });

  it('renders session replay without a recipe as a PASS replay table', () => {
    const out = textOf({
      type: 'session-replay',
      session: {
        id: 'FIT_X',
        tool: 'fit',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        score: 100,
        passed: true,
        durationMs: 1000,
      },
      envelope: buildSignalEnvelope({
        tool: 'fit',
        runId: 'FIT_X',
        createdAt: '2026-01-01T00:00:00.000Z',
        units: [{ slug: 'clean', passed: true, durationMs: 1 }],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
      fidelity: 'projection',
    });

    expect(out).toContain('Session FIT_X');
    expect(out).toContain('PASS');
    expect(out).toContain('replayed (projection)');
    expect(out).not.toContain('recipe');
    expect(out).not.toContain('Use --verbose');
  });

  it('renders help and list views (every result type is now total)', () => {
    expect(renderToText(resultToView({ type: 'help' }))).toContain(
      'Codebase intelligence from your terminal',
    );
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

  it('renders text-lines without a title', () => {
    expect(textOf({ type: 'text-lines', lines: ['alpha'] })).toBe('alpha');
  });

  it('renders an error with the ✗ marker and indented suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', suggestion: 'try --help', exitCode: 1 });
    expect(out).toBe('  ✗ boom\n      try --help');
  });

  it('renders an error without a suggestion', () => {
    const out = textOf({ type: 'error', message: 'boom', exitCode: 1 });
    expect(out).toBe('  ✗ boom');
  });

  // ADR-0011 (Phase 4): sim is migrated — the sim view is derived from the
  // envelope. Scenario `a` passed; scenario `b` failed an assertion (emitting a
  // `high` signal sourced at its scenarioId). The sim builder omits durationMs,
  // so the summary uses the envelope unit-sum (parity with production). The
  // per-scenario table is a verbose/detail surface, not the default run view.
  const bSignal: Signal = {
    id: 'sig_b1',
    source: 'b',
    provider: 'opensip-cli',
    severity: 'high',
    category: 'resilience',
    ruleId: 'invariant.violated',
    message: 'invariant broke',
    filePath: '',
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
  };
  const simBase: RunPresentation = {
    type: 'run-presentation',
    tool: 'simulation',
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
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    }),
  };

  it('renders the non-verbose sim summary from the envelope without a table', () => {
    const out = textOf(simBase);
    expect(out).not.toContain('Unit');
    expect(out).not.toContain('Status');
    expect(out).toContain('FAIL  (1 Errors, 0 Warnings)');
    expect(out).toContain('Use --verbose for detailed results');
  });

  it('renders the sim verbose table from the envelope', () => {
    const out = textOf({ ...simBase, verboseDetail: { kind: 'findings', groups: [] } });
    // One row per scenario-unit, keyed by scenarioId; b's high signal counts
    // as an error on its row and drives the FAIL status.
    expect(out).toContain('Unit');
    expect(out).toContain('Status');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('FAIL  (1 Errors, 0 Warnings)');
    expect(out).not.toContain('Use --verbose for detailed results');
  });

  it('renders the empty-scenarios sim shape (no table, zeroed summary)', () => {
    const out = textOf({
      ...simBase,
      envelope: buildSignalEnvelope({
        tool: 'sim',
        recipe: 'example',
        runId: 'run-1',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [],
        signals: [],
        policy: HOST_VERDICT_POLICY_FALLBACK,
        runFaulted: false,
      }),
    });
    expect(out).toContain('PASS  (0 Errors, 0 Warnings)');
    expect(out).not.toContain('Unit');
    expect(out).not.toContain('Status');
    expect(out).toContain('Use --verbose for detailed results');
  });

  it('renders gate-done lines verbatim', () => {
    const out = textOf({
      type: 'gate-done',
      lines: ['opensip gate compare', '', '✓ STABLE — no change'],
    });
    expect(out).toBe('opensip gate compare\n\n✓ STABLE — no change');
  });

  // envelope-first-presentation RP-2: graph now renders a RunPresentation. The
  // non-regression guarantee — a graph RunPresentation with durationMs > 0 and
  // all-zero envelope units MUST render a NON-zero Duration (the host-owned
  // durationMs wins over the unit-sum, which is 0 for graph; RP-0 Task 0.4).
  it('renders a non-verbose graph RunPresentation: banner, summary, footer, and no per-rule table', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'graph',
      banners: ['Resolution: fast (syntactic) — edges are approximate.'],
      // Host-owned display duration; every unit carries durationMs: 0 (graph's shape).
      durationMs: 1200,
      envelope: buildSignalEnvelope({
        tool: 'graph',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [
          { slug: 'graph.architecture.cycle', passed: true, violationCount: 0, durationMs: 0 },
          {
            slug: 'graph.dead-code.orphan-subtree',
            passed: true,
            violationCount: 1,
            durationMs: 0,
          },
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
    });
    // The resolution caveat renders as a muted banner above the summary.
    expect(out).toContain('Resolution: fast (syntactic)');
    expect(out).not.toContain('graph.dead-code.orphan-subtree');
    expect(out).not.toContain('graph.architecture.cycle');
    expect(out).not.toMatch(/Unit\s+\|\s+Status\s+\|\s+Errors\s+\|\s+Warnings\s+\|\s+Duration/);
    // NON-REGRESSION: the summary Duration is the host value (1.2s), NOT 0ms,
    // despite every unit carrying durationMs: 0.
    expect(out).toContain('| Duration 1.2s');
    expect(out).not.toContain('Duration 0ms');
    // Non-verbose ⇒ the shared footer hint renders.
    expect(out).toContain('Use --verbose for detailed results');
  });

  it('renders a verbose graph RunPresentation with the detailed report and per-rule table', () => {
    const out = textOf({
      type: 'run-presentation',
      tool: 'graph',
      durationMs: 1200,
      envelope: buildSignalEnvelope({
        tool: 'graph',
        runId: 'r',
        createdAt: '2026-06-04T00:00:00.000Z',
        units: [
          {
            slug: 'graph.dead-code.orphan-subtree',
            passed: true,
            violationCount: 1,
            durationMs: 0,
          },
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
      verboseDetail: {
        kind: 'lines',
        lines: ['== Catalog ==', '1 function across 1 file'],
      },
    });
    expect(out).toContain('== Catalog ==');
    expect(out).toContain('Unit');
    expect(out).toContain('Status');
    expect(out).toContain('graph.dead-code.orphan-subtree');
    expect(out).not.toContain('Use --verbose for detailed results');
  });
});
