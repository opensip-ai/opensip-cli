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
          steps: [{ tool: 'fitness', command: 'fit', exitCode: 0, durationMs: 900 }],
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
});