/**
 * Fork-path correlation (subprocess-correlation telemetry spec, Phase 2) — the
 * SYMMETRIC counterpart to the spawn/shard-path assertion. Forks the fixture
 * worker through `createSubprocessProgressRun` inside an entered `RunScope` that
 * carries a parent `runId` + correlation bag, and asserts the child env echoed
 * back over IPC carries:
 *
 *   - `OPENSIP_RUN_ID` = the PARENT run id (B1: runId travels env-only, injected
 *     by the transport from `currentScope()?.runId`, NOT from the descriptor);
 *   - `OPENSIP_WORKER_KIND` = `'live-engine'` (the fork-path worker kind);
 *   - the other correlation fields the descriptor carried;
 *   - NEVER the API key (M1) — correlation env carries no secret.
 *
 * Plus the wire-compat floor: a descriptor with no `correlation` injects no
 * `OPENSIP_*` keys at all (the child inherits the parent env wholesale).
 */

import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { liveEngineCorrelation, type RunCorrelation } from '../../lib/run-correlation.js';
import { RunScope, runWithScope } from '../../lib/run-scope.js';
import { createSubprocessProgressRun } from '../subprocess-transport.js';

const FIXTURE = fileURLToPath(new URL('fixtures/progress-worker.mjs', import.meta.url));

/** Fork the env-echo fixture and resolve the child's `OPENSIP_*` env snapshot. */
function forkAndEchoEnv(
  correlation: RunCorrelation | undefined,
  parentRunId: string,
): Promise<Record<string, string>> {
  const scope = new RunScope({
    runId: parentRunId,
    ...(correlation ? { correlation } : {}),
  });
  return runWithScope(scope, () => {
    const run = createSubprocessProgressRun<number, Record<string, string>>({
      command: FIXTURE,
      argv: ['env-echo'],
      ...(correlation ? { correlation: liveEngineCorrelation(correlation) } : {}),
    });
    return run.result;
  });
}

const PARENT_CORRELATION: RunCorrelation = {
  runId: 'run_parent_fork',
  tool: 'fit',
  parentCommand: 'fit',
  repo: '/work/acme',
};

describe('fork-path correlation (createSubprocessProgressRun)', () => {
  it('injects OPENSIP_RUN_ID from the parent scope and OPENSIP_WORKER_KIND=live-engine', async () => {
    const childEnv = await forkAndEchoEnv(PARENT_CORRELATION, 'run_parent_fork');
    // B1: runId came from the parent scope, NOT the descriptor (which omits it).
    expect(childEnv.OPENSIP_RUN_ID).toBe('run_parent_fork');
    // The fork-path worker kind, stamped by liveEngineCorrelation.
    expect(childEnv.OPENSIP_WORKER_KIND).toBe('live-engine');
    // The rest of the bag rode along.
    expect(childEnv.OPENSIP_TOOL).toBe('fit');
    expect(childEnv.OPENSIP_PARENT_COMMAND).toBe('fit');
    expect(childEnv.OPENSIP_REPO).toBe('/work/acme');
  });

  it('inherits the parent run id even though the descriptor correlation omits runId (B1)', async () => {
    // The descriptor's correlation is `Omit<RunCorrelation,'runId'>`; the only
    // source of OPENSIP_RUN_ID is the transport reading the parent scope.
    const descriptorCorrelation = liveEngineCorrelation(PARENT_CORRELATION);
    expect(descriptorCorrelation).toBeDefined();
    expect('runId' in (descriptorCorrelation as object)).toBe(false);
    const childEnv = await forkAndEchoEnv(PARENT_CORRELATION, 'run_parent_fork');
    expect(childEnv.OPENSIP_RUN_ID).toBe('run_parent_fork');
  });

  it('never places the API key in the child correlation env (M1)', async () => {
    const childEnv = await forkAndEchoEnv(PARENT_CORRELATION, 'run_parent_fork');
    expect(childEnv.OPENSIP_API_KEY).toBeUndefined();
  });

  it('injects no OPENSIP_* keys when the descriptor carries no correlation (wire-compat floor)', async () => {
    const childEnv = await forkAndEchoEnv(undefined, 'run_no_corr');
    // No descriptor.correlation ⇒ the transport injects nothing; the child sees
    // only whatever OPENSIP_* the parent already had (none, in this test scope).
    expect(childEnv.OPENSIP_RUN_ID).toBeUndefined();
    expect(childEnv.OPENSIP_WORKER_KIND).toBeUndefined();
  });
});
