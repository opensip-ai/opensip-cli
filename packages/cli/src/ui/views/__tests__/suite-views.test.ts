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
    ).toContain('Exit: 0');
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
    expect(out).toContain('✓ fitness fit  pass');
    expect(out).toContain('✗ graph graph  fail  2 errors');
    expect(out).toContain('⚠ sim sim  fault  scenario faulted');
    // The detail table is retained; its Verdict column is now 3-way.
    expect(out).toContain('Verdict');
    expect(out).toContain('Counts');
    expect(out).toContain('fault');
    expect(out).toContain('E:0 W:1 F:1');
    expect(out).toContain('E:2 W:0 F:2');
  });

  it('renders suite run scope variants', () => {
    const base = {
      type: 'suite-run' as const,
      suite: 'audit',
      suiteRunId: 'run-1',
      exitCode: 0,
      durationMs: 10,
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
