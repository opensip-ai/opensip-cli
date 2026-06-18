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

import { afterEach, describe, it, expect, vi } from 'vitest';

import { configureLogger } from '../../lib/logger.js';
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

  it('preserves PATH/HOME — correlation env is MERGED over the base env, not a replacement (M2)', async () => {
    const scope = new RunScope({ runId: 'run_parent_fork', correlation: PARENT_CORRELATION });
    const full = await runWithScope(scope, () => {
      const run = createSubprocessProgressRun<
        number,
        { opensip: Record<string, string>; hasPath: boolean; hasHome: boolean }
      >({
        command: FIXTURE,
        argv: ['env-echo-full'],
        correlation: liveEngineCorrelation(PARENT_CORRELATION),
      });
      return run.result;
    });
    // The correlation env rode along...
    expect(full.opensip.OPENSIP_RUN_ID).toBe('run_parent_fork');
    expect(full.opensip.OPENSIP_WORKER_KIND).toBe('live-engine');
    // ...without clobbering the inherited base env (`{ ...process.env, ... }`).
    expect(full.hasPath).toBe(true);
    expect(full.hasHome).toBe(true);
  });
});

interface CorrelationCheckResult {
  readonly hadRunId: boolean;
  readonly mintedFresh: boolean;
  readonly runId: string;
}

describe('fork-path missing-correlation degradation (M2)', () => {
  it('a child with NO correlation warns and proceeds on a FRESH runId — observable, not silent', async () => {
    // No descriptor correlation AND no parent-scope runId ⇒ the child sees no
    // OPENSIP_RUN_ID and takes the warn-and-proceed path (mirrors the real
    // worker's `cli.subprocess.correlation_missing`). The fixture reports it back.
    const run = createSubprocessProgressRun<number, CorrelationCheckResult>({
      command: FIXTURE,
      argv: ['correlation-check'],
    });
    const result = await run.result;
    expect(result.hadRunId).toBe(false);
    expect(result.mintedFresh).toBe(true);
    // It proceeded on a fresh runId rather than crashing or hanging.
    expect(result.runId).toMatch(/^RUN_fresh_/);
  });

  it('a child WITH an inherited runId does NOT degrade — it adopts the parent run', async () => {
    const scope = new RunScope({ runId: 'run_parent_fork', correlation: PARENT_CORRELATION });
    const result = await runWithScope(scope, () => {
      const run = createSubprocessProgressRun<number, CorrelationCheckResult>({
        command: FIXTURE,
        argv: ['correlation-check'],
        correlation: liveEngineCorrelation(PARENT_CORRELATION),
      });
      return run.result;
    });
    expect(result.hadRunId).toBe(true);
    expect(result.mintedFresh).toBe(false);
    expect(result.runId).toBe('run_parent_fork');
  });
});

interface CompleteLog {
  readonly evt?: string;
  readonly runId?: string;
  readonly workerKind?: string;
}

describe('fork-path no duplicate complete under one runId (GAP b)', () => {
  const stderrCalls: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    stderrCalls.length = 0;
    configureLogger({ debugMode: false, silent: true, runId: '' });
  });

  it('emits EXACTLY one parent-side cli.subprocess.complete under the inherited runId', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    // Enable stderr output so the singleton logger's `cli.subprocess.complete`
    // line is captured (the SAME gate the run-id-log-isolation test uses).
    configureLogger({ debugMode: true, silent: false, runId: '' });

    const scope = new RunScope({ runId: 'run_parent_fork', correlation: PARENT_CORRELATION });
    await runWithScope(scope, () => {
      const run = createSubprocessProgressRun<number, string>({
        command: FIXTURE,
        argv: ['emit-and-result'],
        correlation: liveEngineCorrelation(PARENT_CORRELATION),
      });
      return run.result;
    });

    const completes = stderrCalls
      .flatMap((c) => c.split('\n'))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as CompleteLog;
        } catch {
          return {};
        }
      })
      .filter((e) => e.evt === 'cli.subprocess.complete' && e.runId === 'run_parent_fork');

    // GAP b: the PARENT owns the single run-level completion. The child's own
    // worker-scoped `*.worker.complete` (distinguished by workerKind) is NOT
    // duplicated here — exactly one parent-side completion under the runId.
    expect(completes).toHaveLength(1);
    expect(completes[0]?.workerKind).toBe('live-engine');
  });
});
