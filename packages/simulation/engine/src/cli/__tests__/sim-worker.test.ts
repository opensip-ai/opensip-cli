/**
 * `sim-run-worker` — the headless sim run forked by the live view
 * (`executeSimWorker`, ADR-0028). It reads a serializable sim-args spec, runs
 * `executeSim` headless, streams pool progress over the fork IPC channel
 * (`process.send`), and posts the final result. A bad spec is reported as a
 * `{ kind: 'error' }` message, not a throw.
 *
 * The test stubs `process.send` (the process is not actually forked under vitest)
 * and registers a scenario so the default recipe has work to run.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopTarget } from '../../__tests__/test-utils/targets.js';
import { makeSimTestScope } from '../../__tests__/test-utils/with-sim-scope.js';
import { ASSERTIONS } from '../../framework/assertions.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../../framework/registry.js';
import { defineLoadScenario } from '../../kinds/load/define.js';
import { executeSimWorker } from '../sim-worker.js';

import type { executeSim } from '../sim.js';
import type { ProgressEvent } from '@opensip-cli/cli-ui';
import type { WorkerMessage } from '@opensip-cli/core';

type Msg = WorkerMessage<ProgressEvent, Awaited<ReturnType<typeof executeSim>>>;

let dir: string;
let messages: Msg[];

beforeEach(() => {
  enterScope(makeSimTestScope());
  dir = mkdtempSync(join(tmpdir(), 'sim-worker-test-'));
  messages = [];
  // The worker posts via process.send (a no-op when not forked); stub it to capture.
  // process.send is undefined under vitest, so deleting it in afterEach restores state.
  (process as { send?: unknown }).send = vi.fn((m: Msg) => {
    messages.push(m);
    return true;
  });
});

afterEach(() => {
  clearScenarioRegistry();
  delete (process as { send?: unknown }).send;
  rmSync(dir, { recursive: true, force: true });
});

describe('executeSimWorker', () => {
  it('runs the sim and posts progress + a result over IPC', async () => {
    currentScenarioRegistry().register(
      defineLoadScenario({
        id: 'worker-probe',
        name: 'worker-probe',
        description: 'worker-probe',
        tags: [],
        target: noopTarget,
        workload: { rps: 1 },
        duration: 1,
        assertions: [ASSERTIONS.lowErrorRate(1)],
      }),
    );
    const specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ json: false, cwd: dir, debug: false }), 'utf8');

    await executeSimWorker(specPath);

    expect(messages.some((m) => m.kind === 'progress')).toBe(true);
    const result = messages.find((m) => m.kind === 'result');
    expect(result?.kind).toBe('result');
    if (result?.kind !== 'result') throw new Error('no result message');
    expect(result.value.result.type).toBe('run-presentation');
  });

  it('reports a bad spec path as an error message, not a throw', async () => {
    await expect(executeSimWorker(join(dir, 'missing.json'))).resolves.toBeUndefined();
    const err = messages.find((m) => m.kind === 'error');
    expect(err?.kind).toBe('error');
    expect(messages.some((m) => m.kind === 'result')).toBe(false);
  });
});
