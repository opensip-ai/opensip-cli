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
            },
          ],
        }),
      ),
    ).toContain('Exit: 0');

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
            verdict: { passed: true, errors: 0, warnings: 1, findings: 1 },
          },
          {
            tool: 'graph',
            stableId: 'uuid-2',
            command: 'graph',
            exitCode: 1,
            durationMs: 400,
            verdict: { passed: false, errors: 2, warnings: 0, findings: 2 },
          },
          {
            tool: 'sim',
            stableId: 'uuid-3',
            command: 'sim',
            exitCode: 1,
            durationMs: 300,
            error: 'scenario faulted',
          },
        ],
      }),
    );

    expect(out).toContain('Aggregate:');
    expect(out).toContain('3 steps');
    expect(out).toContain('1 passed');
    expect(out).toContain('1 failed');
    expect(out).toContain('1 faulted');
    expect(out).toContain('Verdict');
    expect(out).toContain('Counts');
    expect(out).toContain('pass');
    expect(out).toContain('fail');
    expect(out).toContain('E:0 W:1 F:1');
    expect(out).toContain('E:2 W:0 F:2');
    expect(out).toContain('scenario faulted');
  });
});
