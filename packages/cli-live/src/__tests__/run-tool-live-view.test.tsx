/**
 * @fileoverview Integration tests for the shared live-run state machine.
 */

import {
  createRunLogger,
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runToolLiveView } from '../run-tool-live-view.js';

import type { RunScopeOptions } from '@opensip-cli/core';

const ACT_GLOBAL = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_GLOBAL.IS_REACT_ACT_ENVIRONMENT = true;

function makeScope(opts: RunScopeOptions = {}): RunScope {
  return new RunScope({
    ...opts,
    languages: new LanguageRegistry(),
    logger: opts.logger,
    tools: new ToolRegistry(),
    runId: 'RUN_liveview_test',
  });
}

function stderrEvents(calls: readonly string[]): Record<string, unknown>[] {
  return calls
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((row): row is Record<string, unknown> => row !== undefined);
}

describe('runToolLiveView', () => {
  const stderrCalls: string[] = [];

  beforeEach(() => {
    stderrCalls.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('returns session and envelope from a successful produce()', async () => {
    const scope = makeScope();
    const onEnvelope = vi.fn();
    const completion = await runWithScope(scope, () =>
      runToolLiveView(
        {
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
        },
        { onEnvelope },
      ),
    );

    expect(completion.session?.tool).toBe('yagni');
    expect(completion.envelope?.signals).toEqual([]);
    expect(onEnvelope).toHaveBeenCalledWith(completion.envelope);
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

  it('renders suggested recovery text for produce error outcomes', async () => {
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
              message: 'invalid recipe',
              suggestion: 'Run opensip sim recipes',
              exitCode: 2,
            }),
        },
        { setExitCode },
      ),
    );

    expect(setExitCode).toHaveBeenCalledWith(2);
  }, 10_000);

  it('allows progressOnDone without a running subscriber', async () => {
    const scope = makeScope();

    const completion = await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'graph',
        meta: { title: 'Test', description: 'Running' },
        surface: {
          shape: 'phases',
          stages: [{ id: 'parse', label: 'Parse project' }],
        },
        verbose: false,
        quiet: true,
        progressOnDone: true,
        produce: () =>
          Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          }),
      }),
    );

    expect(completion).toEqual({});
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
          helpers.setHeaderMetadata([{ label: 'checks', value: '1/1' }]);
          helpers.setShowRunHeader(false);
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

  it('reads UI and project defaults from the current run scope', async () => {
    const scope = makeScope({
      ui: { bannerSize: 'mini', version: '0.1.11', update: '0.1.12' },
      projectContext: {
        cwd: '/repo/subdir',
        cwdExplicit: false,
        projectRoot: '/repo',
        configPath: '/repo/opensip-cli.config.yml',
        walkedUp: 1,
        scope: 'project',
      },
    });

    const completion = await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'fit',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Working...' },
        verbose: false,
        quiet: true,
        produce: () =>
          Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          }),
      }),
    );

    expect(completion).toEqual({});
  }, 10_000);

  it('replays direct progress events emitted before the renderer subscribes', async () => {
    const scope = makeScope();
    const originalWrite = process.stdout.write.bind(process.stdout);
    const stdoutCalls: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      stdoutCalls.push(String(chunk));
      return originalWrite(chunk, ...args);
    });

    await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'yagni',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Running detectors...' },
        verbose: false,
        quiet: true,
        progressOnDone: true,
        produce: async (progressEmit, helpers) => {
          progressEmit({ type: 'stage-progress', stage: 'detectors', completed: 2, total: 4 });
          helpers.setRunning(() => {
            // In-process direct-emitter path.
          });
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          return {
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          };
        },
      }),
    );

    expect(stdoutCalls.join('')).toContain('2/4 (50%)');
    stdoutSpy.mockRestore();
  }, 10_000);

  it('replays transport progress when progressOnDone remounts the subscriber', async () => {
    const scope = makeScope();
    const originalWrite = process.stdout.write.bind(process.stdout);
    const stdoutCalls: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      stdoutCalls.push(String(chunk));
      return originalWrite(chunk, ...args);
    });

    await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'graph',
        meta: { title: 'Test', description: 'Running' },
        surface: {
          shape: 'phases',
          stages: [{ id: 'parse', label: 'Parse project' }],
        },
        verbose: false,
        quiet: true,
        progressOnDone: true,
        produce: async (_progressEmit, helpers) => {
          helpers.setRunning((cb) => {
            cb({ type: 'stage-done', stage: 'parse', durationMs: 1200, detail: '42 file(s)' });
          });
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          return {
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          };
        },
      }),
    );

    expect(stdoutCalls.join('')).toContain('42 file(s) (1.2s)');
    stdoutSpy.mockRestore();
  }, 10_000);

  it('emits cli.liveview.run.start and complete observability events', async () => {
    const logger = createRunLogger({
      runId: 'RUN_liveview_test',
      debugMode: true,
      silent: false,
      level: 'info',
    });
    const scope = makeScope({ logger });

    await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'graph',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Working...' },
        verbose: false,
        quiet: true,
        produce: () =>
          Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          }),
      }),
    );

    const events = stderrEvents(stderrCalls).map((row) => row.evt);
    expect(events).toContain('cli.liveview.run.start');
    expect(events).toContain('cli.liveview.run.complete');
  }, 10_000);

  it('scrubs secrets in error outcomes and logs cli.liveview.run.error', async () => {
    const logger = createRunLogger({
      runId: 'RUN_liveview_test',
      debugMode: true,
      silent: false,
      level: 'info',
    });
    const scope = makeScope({ logger });
    const setExitCode = vi.fn();

    await runWithScope(scope, () =>
      runToolLiveView(
        {
          tool: 'yagni',
          meta: { title: 'Test', description: 'Running' },
          surface: { shape: 'pool', label: 'Working...' },
          verbose: false,
          quiet: true,
          produce: () =>
            Promise.resolve({
              kind: 'error',
              message: `failed api_key=${'x'.repeat(600)}`,
              exitCode: 2,
            }),
        },
        { setExitCode },
      ),
    );

    expect(setExitCode).toHaveBeenCalledWith(2);
    const errorEvt = stderrEvents(stderrCalls).find((row) => row.evt === 'cli.liveview.run.error');
    expect(errorEvt?.tool).toBe('yagni');
    expect(String(errorEvt?.message)).toContain('[redacted]');
    expect(String(errorEvt?.message).length).toBeLessThanOrEqual(501);
  }, 10_000);

  it('handles producer rejection without an unhandled rejection', async () => {
    const logger = createRunLogger({
      runId: 'RUN_liveview_test',
      debugMode: true,
      silent: false,
      level: 'info',
    });
    const scope = makeScope({ logger });
    const setExitCode = vi.fn();

    await runWithScope(scope, () =>
      runToolLiveView(
        {
          tool: 'fit',
          meta: { title: 'Test', description: 'Running' },
          surface: { shape: 'pool', label: 'Working...' },
          verbose: false,
          quiet: true,
          produce: () => Promise.reject(new Error('api_key=leaked')),
        },
        { setExitCode },
      ),
    );

    expect(setExitCode).toHaveBeenCalledWith(1);
    const errorEvt = stderrEvents(stderrCalls).find((row) => row.evt === 'cli.liveview.run.error');
    expect(errorEvt?.tool).toBe('fit');
    expect(String(errorEvt?.message)).toContain('[redacted]');
  }, 10_000);

  it('writes a trailing newline after the Ink app exits', async () => {
    const scope = makeScope();
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: unknown[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      writes.push(chunk);
      return originalWrite(chunk, ...args);
    });

    await runWithScope(scope, () =>
      runToolLiveView({
        tool: 'sim',
        meta: { title: 'Test', description: 'Running' },
        surface: { shape: 'pool', label: 'Working...' },
        verbose: false,
        quiet: true,
        produce: () =>
          Promise.resolve({
            kind: 'done',
            done: { summary: { passed: true, errors: 0, warnings: 0 } },
          }),
      }),
    );

    expect(writes.includes('\n')).toBe(true);
    stdoutSpy.mockRestore();
  }, 10_000);
});
