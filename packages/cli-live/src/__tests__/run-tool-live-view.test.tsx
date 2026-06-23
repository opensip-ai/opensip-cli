/**
 * @fileoverview Integration tests for the shared live-run state machine.
 */

import { LanguageRegistry, RunScope, ToolRegistry, runWithScope } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { runToolLiveView } from '../run-tool-live-view.js';

const ACT_GLOBAL = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_GLOBAL.IS_REACT_ACT_ENVIRONMENT = true;

function makeScope(): RunScope {
  return new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
  });
}

describe('runToolLiveView', () => {
  it('returns session and envelope from a successful produce()', async () => {
    const scope = makeScope();
    const completion = await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'yagni',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Working...' },
        verbose: false,
        quiet: true,
        produce: () =>
          Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
            session: { tool: 'yagni', cwd: '/proj', passed: true, score: 100 },
            envelope: {
              signals: [],
              units: [],
              verdict: { passed: true, summary: { total: 0, errors: 0, warnings: 0 } },
            },
          }),
      }),
    );

    expect(completion.session?.tool).toBe('yagni');
    expect(completion.envelope?.signals).toEqual([]);
  }, 10_000);

  it('invokes setExitCode on produce error outcomes', async () => {
    const scope = makeScope();
    const setExitCode = vi.fn();

    await runWithScope(scope, () =>
      runToolLiveView(
        {
          tool: 'sim',
          meta: { title: 'Test', description: 'Running' },
          surface: { shape: 'pool', label: 'Working...' },
          verbose: false,
          quiet: true,
          produce: () =>
            Promise.resolve({
              kind: 'error',
              message: 'api_key=secret',
              exitCode: 2,
            }),
        },
        { setExitCode },
      ),
    );

    expect(setExitCode).toHaveBeenCalledWith(2);
  }, 10_000);

  it('passes emit and setRunning helpers to produce()', async () => {
    const scope = makeScope();
    let helperSurface:
      | {
          readonly setRunning: unknown;
          readonly setHeaderMetadata: unknown;
          readonly setShowRunHeader: unknown;
        }
      | undefined;
    const workerTransport = vi.fn();

    await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'fit',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Working...' },
        verbose: false,
        quiet: true,
        produce: (progressEmit, helpers) => {
          progressEmit({ type: 'stage-start', stage: 'checks', label: 'Checks' });
          helperSurface = helpers;
          helpers.setRunning(workerTransport);
          return Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          });
        },
      }),
    );

    expect(helperSurface?.setRunning).toBeTypeOf('function');
    expect(helperSurface?.setHeaderMetadata).toBeTypeOf('function');
    expect(helperSurface?.setShowRunHeader).toBeTypeOf('function');
    expect(workerTransport).toBeTypeOf('function');
  }, 10_000);
});
