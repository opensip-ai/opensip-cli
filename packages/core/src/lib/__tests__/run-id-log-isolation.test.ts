/**
 * Per-runId log isolation under concurrency — the spec's "Observable" success
 * criterion (parallel-tool-invocations Phase 4; ADR-0053).
 *
 * The kernel wires the singleton logger's runId source to the ALS-bound scope at
 * module init: `setRunIdProvider(() => currentScope()?.runId)` (`run-scope.ts`).
 * So two in-process scopes with distinct `runId`s, each emitting through the
 * SAME singleton logger inside its own `runWithScope`, produce log lines stamped
 * with their OWN runId — filterable per run, with no cross-stamping even when the
 * two runs interleave.
 *
 * NOTE on the harness: the phase file suggested `runTwoScopesConcurrently` from
 * `@opensip-cli/test-support`, but `core` CANNOT depend on `test-support` — that
 * package depends on `core`, so the edge would make the package graph cyclic
 * (see the same constraint documented in `verdict-policy.test.ts`). We therefore
 * inline the two-scope concurrency with `Promise.all([runWithScope(a, …),
 * runWithScope(b, …)])` — exactly what `runTwoScopesConcurrently` does internally.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureLogger, logger as defaultLogger } from '../logger.js';
import { RunScope, runWithScope } from '../run-scope.js';

interface CapturedEntry {
  readonly evt?: string;
  readonly runId?: string;
}

describe('per-runId log isolation under concurrency (ADR-0053)', () => {
  const stderrCalls: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    stderrCalls.length = 0;
    // Reset the singleton's instance-level runId so it can't shadow later tests.
    configureLogger({ runId: '' });
  });

  /** Parse the captured stderr JSON lines for entries matching `evt`. */
  function entriesFor(evt: string): CapturedEntry[] {
    return stderrCalls
      .map((c) => JSON.parse(c.trim()) as CapturedEntry)
      .filter((e) => e.evt === evt);
  }

  it('two concurrent scopes stamp their own runId — no cross-stamping', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    // Enable stderr output. Clear the singleton's instance runId so the
    // scope-bound runIdProvider is the only source (no fallback shadowing).
    configureLogger({ debugMode: true, silent: false, runId: '' });

    const scopeA = new RunScope({ runId: 'run_A' });
    const scopeB = new RunScope({ runId: 'run_B' });

    // Interleave the two runs through the microtask queue: each yields a tick
    // between two emissions so A's and B's log calls are genuinely intermixed.
    // The runIdProvider must resolve the ALS-bound scope at EACH emission.
    await Promise.all([
      runWithScope(scopeA, async () => {
        defaultLogger.info({ evt: 'iso.a', msg: 'a-1' });
        await Promise.resolve();
        defaultLogger.info({ evt: 'iso.a', msg: 'a-2' });
      }),
      runWithScope(scopeB, async () => {
        defaultLogger.info({ evt: 'iso.b', msg: 'b-1' });
        await Promise.resolve();
        defaultLogger.info({ evt: 'iso.b', msg: 'b-2' });
      }),
    ]);

    const aEntries = entriesFor('iso.a');
    const bEntries = entriesFor('iso.b');

    // Both emissions from each run were captured…
    expect(aEntries).toHaveLength(2);
    expect(bEntries).toHaveLength(2);

    // …and every run-A entry is stamped run_A (never run_B), and vice versa:
    // the two concurrent scopes' logs are filterable by runId with no
    // cross-contamination.
    expect(aEntries.every((e) => e.runId === 'run_A')).toBe(true);
    expect(bEntries.every((e) => e.runId === 'run_B')).toBe(true);

    // Symmetric: no run-A line leaked run_B's id, and no run-B line leaked run_A's.
    const allRunIds = [...aEntries, ...bEntries].map((e) => e.runId);
    expect(allRunIds.filter((id) => id === 'run_A')).toHaveLength(2);
    expect(allRunIds.filter((id) => id === 'run_B')).toHaveLength(2);

    scopeA.dispose();
    scopeB.dispose();
  });

  it('a third run filters cleanly alongside the other two (per-runId filterability)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    configureLogger({ debugMode: true, silent: false, runId: '' });

    const scopes = ['run_1', 'run_2', 'run_3'].map((runId) => new RunScope({ runId }));

    await Promise.all(
      scopes.map((scope) =>
        runWithScope(scope, async () => {
          defaultLogger.info({ evt: 'iso.multi', msg: scope.runId });
          await Promise.resolve();
          defaultLogger.info({ evt: 'iso.multi', msg: `${scope.runId}-2` });
        }),
      ),
    );

    const entries = entriesFor('iso.multi');
    expect(entries).toHaveLength(6);
    // Each runId is filterable to exactly its own two lines.
    for (const runId of ['run_1', 'run_2', 'run_3']) {
      expect(entries.filter((e) => e.runId === runId)).toHaveLength(2);
    }

    for (const scope of scopes) scope.dispose();
  });
});
