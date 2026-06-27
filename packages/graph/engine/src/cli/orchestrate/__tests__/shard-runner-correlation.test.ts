/**
 * Shard runner — the spawn-path CORRELATION + failure-taxonomy contract
 * (subprocess-correlation telemetry spec, Phase 1). Drives REAL child processes
 * via a fixture "CLI" worker (the same harness pattern as `shard-runner-spawn`):
 *
 *   - the worker inherits the PARENT run via `OPENSIP_RUN_ID` env (B1) — the spec
 *     JSON carries `correlation` WITHOUT `runId`, and the child sees the parent's
 *     `OPENSIP_RUN_ID` in its env;
 *   - a non-zero exit yields a `ShardFailure { failureClass: 'exit_nonzero' }` and
 *     a structured `graph.shard.runner.shard_failed` event whose `stderrPreview`
 *     is capped at 500 chars while the returned `ShardFailure.stderr` stays FULL
 *     (M4);
 *   - a hung shard past a SHORT injected kill-timeout settles as
 *     `failureClass: 'timeout'` (M3) — never an indefinite hang;
 *   - an OLD-build spec WITHOUT a `correlation` field still builds (wire-compat,
 *     GAP a) — the worker tolerates `spec.correlation === undefined`.
 *
 * The fixture echoes the env + spec it saw back through its stdout JSON so the
 * test can assert what the runner forwarded without standing up a real build.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureLogger, RunScope, runWithScope, type RunCorrelation } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runShardsInParallel } from '../shard-runner.js';

import type { Shard } from '../shard-model.js';

// The fixture worker, invoked as `node <script> graph-shard-worker <specPath>`.
//  - `fail:<id>`  → exit 3 with a LONG stderr (proves the 500-char preview cap
//                   while the full stderr survives on the ShardFailure).
//  - `sleep:<id>` → sleep well past the injected short kill-timeout (proves M3).
//  - anything else → emit a ShardBuildResult whose `fragment.cacheKey` carries an
//    env+spec snapshot: the OPENSIP_RUN_ID the child saw and whether the spec had
//    a `correlation` (and, if so, its runId-stripped shape).
const WORKER_SCRIPT = String.raw`
const { readFileSync } = require('node:fs');
const specPath = process.argv[3];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const id = spec.shard.id;
if (id.startsWith('fail:')) {
  process.stderr.write('boom '.repeat(200) + 'for ' + id + '\n');
  process.exit(3);
}
if (id.startsWith('sleep:')) {
  // Hang past the injected short kill-timeout; the parent SIGKILLs us.
  setTimeout(() => process.exit(0), 60_000);
  return;
}
const snapshot = {
  runIdEnv: process.env.OPENSIP_RUN_ID ?? null,
  specHasCorrelation: spec.correlation !== undefined,
  specCorrelation: spec.correlation ?? null,
};
const result = {
  shardId: id,
  fragment: {
    version: '3.0', tool: 'graph', language: spec.language ?? 'typescript',
    builtAt: 'x', cacheKey: JSON.stringify(snapshot), resolutionMode: 'exact', functions: {},
  },
  fingerprint: 'fp-' + id,
  boundaryCalls: [],
  parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

interface WorkerSnapshot {
  readonly runIdEnv: string | null;
  readonly specHasCorrelation: boolean;
  readonly specCorrelation: Omit<RunCorrelation, 'runId'> | null;
}

const PARENT_CORRELATION: RunCorrelation = {
  runId: 'RUN_test',
  tool: 'graph',
  parentCommand: 'graph',
  repo: '/work/acme',
};

interface CapturedLog {
  readonly evt?: string;
  readonly shardId?: string;
  readonly exitCode?: number;
  readonly failureClass?: string;
  readonly stderrPreview?: string;
  readonly runId?: string;
}

describe('runShardsInParallel — spawn-path correlation + failure taxonomy', () => {
  let dir: string;
  let cliScript: string;
  const stderrCalls: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-corr-'));
    cliScript = join(dir, 'fake-cli.cjs');
    writeFileSync(cliScript, WORKER_SCRIPT, 'utf8');
    stderrCalls.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    // Restore the singleton logger to its quiet default so capture state can't
    // leak into sibling suites.
    configureLogger({ debugMode: false, silent: true, runId: '' });
  });

  function shard(id: string): Shard {
    return { id, rootDir: dir, files: [join(dir, `${id}.ts`)] };
  }

  /**
   * Capture the singleton logger's JSONL by enabling stderr output (the runner
   * emits through the imported `logger` singleton) and routing stderr through a
   * spy. `silent: false` + `debugMode: true` is the only mode in which the
   * singleton writes its structured lines to stderr (the SAME gate the
   * run-id-log-isolation test uses).
   */
  function captureLogs(): void {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    configureLogger({ debugMode: true, silent: false, runId: '' });
  }

  function loggedEvents(evt: string): CapturedLog[] {
    return stderrCalls
      .flatMap((c) => c.split('\n'))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as CapturedLog;
        } catch {
          return {};
        }
      })
      .filter((e) => e.evt === evt);
  }

  /** Run the pool inside a scope carrying the parent correlation bag. */
  function runWithCorrelation(
    shards: readonly Shard[],
    opts: { hardKillTimeoutMs?: number } = {},
  ): Promise<Awaited<ReturnType<typeof runShardsInParallel>>> {
    const scope = new RunScope({
      runId: PARENT_CORRELATION.runId,
      correlation: PARENT_CORRELATION,
    });
    return runWithScope(scope, () =>
      runShardsInParallel({
        shards: [...shards],
        projectRoot: dir,
        cliScript,
        resolutionMode: 'exact',
        ...(opts.hardKillTimeoutMs === undefined
          ? {}
          : { hardKillTimeoutMs: opts.hardKillTimeoutMs }),
      }),
    );
  }

  it('forwards OPENSIP_RUN_ID to the child (B1) and writes correlation sans runId into the spec', async () => {
    const out = await runWithCorrelation([shard('pkg:a')]);
    expect(out.failures).toHaveLength(0);
    const snap = JSON.parse(out.fragments[0].fragment.cacheKey) as WorkerSnapshot;

    // The child inherited the PARENT run via env (B1) — not via the spec JSON.
    expect(snap.runIdEnv).toBe('RUN_test');
    // The spec carries correlation, but NOT runId (it is env-only).
    expect(snap.specHasCorrelation).toBe(true);
    expect(snap.specCorrelation).not.toBeNull();
    expect(snap.specCorrelation).not.toHaveProperty('runId');
    // The rest of the bag rode along in the spec, plus this shard's id/workerKind.
    expect(snap.specCorrelation?.tool).toBe('graph');
    expect(snap.specCorrelation?.parentCommand).toBe('graph');
    expect(snap.specCorrelation?.shardId).toBe('pkg:a');
    expect(snap.specCorrelation?.workerKind).toBe('shard');
  });

  it('emits graph.shard.runner.shard_failed (exit_nonzero) with a ≤500-char preview; full stderr untruncated (M4)', async () => {
    captureLogs();
    const out = await runWithCorrelation([shard('fail:x')]);

    expect(out.failures).toHaveLength(1);
    const failure = out.failures[0];
    expect(failure.shardId).toBe('fail:x');
    expect(failure.exitCode).toBe(3);
    expect(failure.failureClass).toBe('exit_nonzero');
    // The returned ShardFailure.stderr is the FULL captured output (M4): the
    // fixture writes ~1000 chars of 'boom ' — well over the 500-char preview cap.
    expect(failure.stderr.length).toBeGreaterThan(500);
    expect(failure.stderr).toContain('for fail:x');

    const [event] = loggedEvents('graph.shard.runner.shard_failed');
    expect(event).toBeDefined();
    expect(event?.shardId).toBe('fail:x');
    expect(event?.exitCode).toBe(3);
    expect(event?.failureClass).toBe('exit_nonzero');
    expect(event?.runId).toBe('RUN_test');
    // The structured event's preview is independently capped at 500 chars.
    expect((event?.stderrPreview ?? '').length).toBeLessThanOrEqual(500);
  });

  it('kills a hung shard at the injected timeout → failureClass timeout (M3)', async () => {
    captureLogs();
    // A 200ms injected kill-timeout: the fixture sleeps 60s, so the parent must
    // SIGKILL it and settle as `timeout` — the test itself completes far under
    // the 10-minute production default (proving no indefinite hang).
    const out = await runWithCorrelation([shard('sleep:hang')], {
      hardKillTimeoutMs: 200,
    });

    expect(out.fragments).toHaveLength(0);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]?.shardId).toBe('sleep:hang');
    expect(out.failures[0]?.failureClass).toBe('timeout');
    expect(out.failures[0]?.stderr).toContain('hard kill-timeout');

    const [event] = loggedEvents('graph.shard.runner.shard_failed');
    expect(event?.failureClass).toBe('timeout');
    expect(event?.shardId).toBe('sleep:hang');
  }, 15_000);

  it('builds a spec WITHOUT a correlation field (wire-compat, GAP a) — no throw, valid result', async () => {
    // Run OUTSIDE any scope correlation: spawnShardWorker reads
    // currentScope()?.correlation === undefined, so the spec omits `correlation`
    // entirely. The worker must tolerate that and still produce a ShardBuildResult.
    const out = await runShardsInParallel({
      shards: [shard('pkg:nocorr')],
      projectRoot: dir,
      cliScript,
      resolutionMode: 'exact',
    });

    expect(out.failures).toHaveLength(0);
    expect(out.fragments).toHaveLength(1);
    const snap = JSON.parse(out.fragments[0].fragment.cacheKey) as WorkerSnapshot;
    // GAP a: no scope correlation ⇒ the runner omits `correlation` from the spec,
    // and the worker tolerates `spec.correlation === undefined` (no throw — proven
    // by the valid ShardBuildResult above).
    expect(snap.specHasCorrelation).toBe(false);
    expect(snap.specCorrelation).toBeNull();
  });
});
