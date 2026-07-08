import { renderToText } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import { viewSuiteAdd, viewSuiteList, viewSuiteRun } from '../suite-views.js';

describe('suite view builders', () => {
  it('renders suite list rows with and without args', () => {
    const out = renderToText(
      viewSuiteList({
        type: 'suite-list',
        totalCount: 1,
        suites: [
          {
            name: 'security',
            steps: [
              {
                tool: 'fitness',
                stableId: 'uuid-1',
                command: 'fit',
                args: {},
              },
              {
                tool: 'graph',
                stableId: 'uuid-2',
                command: 'graph',
                args: { json: true },
              },
            ],
          },
        ],
      }),
    );

    expect(out).toContain('Suites (1)');
    expect(out).toContain('uuid-1');
    expect(out).toContain('-');
    expect(out).toContain('{"json":true}');
  });

  it('renders successful suite steps and unchanged add results', () => {
    expect(
      renderToText(
        viewSuiteRun({
          type: 'suite-run',
          suite: 'security',
          suiteRunId: 'run-1',
          exitCode: 0,
          durationMs: 900,
          steps: [
            {
              tool: 'fitness',
              stableId: 'uuid-1',
              command: 'fit',
              exitCode: 0,
              durationMs: 900,
              outcome: 'passed',
            },
          ],
        }),
      ),
    ).toContain('PASS  (0 Errors, 0 Warnings)');
    expect(
      renderToText(
        viewSuiteRun({
          type: 'suite-run',
          suite: 'security',
          suiteRunId: 'run-1',
          exitCode: 0,
          durationMs: 900,
          steps: [],
        }),
      ),
    ).not.toContain('Scope:');

    expect(
      renderToText(
        viewSuiteAdd({
          type: 'suite-add',
          suite: 'security',
          tool: 'fitness',
          stableId: 'uuid-1',
          command: 'fit',
          configPath: '/repo/opensip-cli.config.yml',
          changed: false,
        }),
      ),
    ).toContain('Suite already contained');
  });

  it('renders suite aggregate and per-step verdict counts when present', () => {
    const out = renderToText(
      viewSuiteRun({
        type: 'suite-run',
        suite: 'security',
        suiteRunId: 'run-1',
        exitCode: 1,
        durationMs: 1200,
        verbose: true,
        aggregate: {
          steps: 3,
          passed: 1,
          failed: 1,
          faulted: 1,
          errors: 2,
          warnings: 1,
        },
        steps: [
          {
            tool: 'fitness',
            stableId: 'uuid-1',
            command: 'fit',
            exitCode: 0,
            durationMs: 500,
            outcome: 'passed',
            verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
          },
          {
            tool: 'graph',
            stableId: 'uuid-2',
            command: 'graph',
            exitCode: 1,
            durationMs: 400,
            outcome: 'failed',
            verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
          },
          {
            tool: 'sim',
            stableId: 'uuid-3',
            command: 'sim',
            exitCode: 1,
            durationMs: 300,
            outcome: 'faulted',
            error: 'scenario faulted',
          },
        ],
      }),
    );

    // The 3-way count line (N/M fractions), with the fault class named.
    expect(out).toContain('1/3 passed · 1/3 failed · 1/3 faulted (runtime error)');
    // All-step bullets (suite `showAll`): a fault reads `fault`, not `fail`.
    // Labels dedupe when tool === command: 'graph graph' → 'graph', 'sim sim' → 'sim'.
    expect(out).toContain('✓ fitness fit  pass');
    expect(out).toContain('✗ graph  fail  2 errors');
    expect(out).toContain('⚠ sim  fault  scenario faulted');
    // The detail table is retained; its Verdict column is now 3-way.
    expect(out).toContain('Verdict');
    expect(out).toContain('Counts');
    expect(out).toContain('fault');
    expect(out).toContain('E:0 W:1 F:1');
    expect(out).toContain('E:2 W:0 F:2');
  });

  it('default (non-verbose) surface is compact: count line + deduped bullets, no tables', () => {
    const out = renderToText(
      viewSuiteRun({
        type: 'suite-run',
        suite: 'audit',
        suiteRunId: 'run-1',
        exitCode: 1,
        durationMs: 100,
        aggregate: { steps: 2, passed: 1, failed: 1, faulted: 0, errors: 2, warnings: 0 },
        steps: [
          {
            tool: 'fitness',
            stableId: 'uuid-1',
            command: 'fitness',
            exitCode: 1,
            durationMs: 5,
            outcome: 'failed',
            verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
          },
          {
            tool: 'yagni',
            stableId: 'uuid-2',
            command: 'yagni',
            exitCode: 0,
            durationMs: 5,
            outcome: 'passed',
            verdict: { passed: true, errors: 0, warnings: 0, findings: 0 },
          },
        ],
        reviewBrief: {
          version: 1,
          suite: 'audit',
          suiteRunId: 'run-1',
          verdict: 'fail',
          changedFiles: null,
          topRisks: [
            {
              source: 'fit',
              ruleId: 'no-eval',
              message: 'eval detected',
              severity: 'high',
              file: 'src/a.ts',
              isNew: false,
              signalRef: { tool: 'fit', suiteRunId: 'run-1', stepIndex: 0, signalIndex: 0 },
            },
          ],
          newFindings: [],
          baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
          degraded: [],
          recommendedActions: [],
        },
      }),
    );
    // Compact: count line + deduped per-step bullets (fitness/yagni show once).
    expect(out).toContain('1/2 passed · 1/2 failed · 0/2 faulted');
    expect(out).toContain('✗ fitness  fail  2 errors');
    expect(out).toContain('✓ yagni  pass');
    // The one-line Review verdict shows its risk count in the concise form...
    expect(out).toContain('Review: FAIL');
    expect(out).toContain('1 risk');
    // ...and the canonical run-summary headline is present.
    expect(out).toContain('FAIL  (2 Errors, 0 Warnings)');
    // ...but NO detail tables by default (no step table, no risks table).
    expect(out).not.toContain('Verdict');
    expect(out).not.toContain('no-eval');
    expect(out).not.toContain('src/a.ts');
  });

  it('renders suite run scope variants (verbose detail)', () => {
    // Scope + run id live in the --verbose detail band now, not the default surface.
    const base = {
      type: 'suite-run' as const,
      suite: 'audit',
      suiteRunId: 'run-1',
      exitCode: 0,
      durationMs: 10,
      verbose: true,
      steps: [],
    };

    expect(
      renderToText(
        viewSuiteRun({
          ...base,
          scope: { mode: 'changed', source: 'default', changedFiles: 14 },
        }),
      ),
    ).toContain('Scope: changed (working tree, 14 files)');

    expect(
      renderToText(
        viewSuiteRun({
          ...base,
          scope: {
            mode: 'changed',
            source: 'explicit',
            ref: 'main',
            changedFiles: 1,
          },
        }),
      ),
    ).toContain('Scope: changed since main (1 file)');

    expect(
      renderToText(
        viewSuiteRun({
          ...base,
          scope: { mode: 'changed', source: 'explicit' },
        }),
      ),
    ).toContain('Scope: changed');

    expect(
      renderToText(
        viewSuiteRun({
          ...base,
          scope: { mode: 'full', source: 'explicit' },
        }),
      ),
    ).toContain('Scope: full (--full)');

    const fallback = renderToText(
      viewSuiteRun({
        ...base,
        scope: {
          mode: 'full',
          source: 'fallback',
          notice: 'not a git repository; running the full scope',
        },
      }),
    );
    expect(fallback).toContain('Scope: full');
    expect(fallback).toContain('not a git repository; running the full scope');

    expect(
      renderToText(
        viewSuiteRun({
          ...base,
          scope: { mode: 'full', source: 'default' },
        }),
      ),
    ).toContain('Scope: full');
  });
});
