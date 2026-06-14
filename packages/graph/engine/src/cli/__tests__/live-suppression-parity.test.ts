/**
 * Regression: the LIVE-view producer waives `@graph-ignore` directives
 * IDENTICALLY to the static `dispatchGraphResult` path.
 *
 * History — the un-regressable fix: suppression used to be applied ONLY inside
 * the `executeGraph` / `dispatchGraphResult` family (the static / piped / `--json`
 * / `--gate-*` path). A bare `graph` in a TTY routed to a SEPARATE live-view path
 * (`GraphRunner` in-process producer + the off-process `graph-run-worker`
 * subprocess producer, both via `buildLiveGraphOutput`) that NEVER applied
 * suppression — so a TTY run leaked every `@graph-ignore` waiver as a finding
 * while the piped run was clean. Prior fixes patched the static path only and the
 * leak kept coming back.
 *
 * The structural fix routes BOTH paths through ONE chokepoint
 * (`finalizeGraphSignals`): the static path calls it directly in
 * `dispatchGraphResult`, and the live path's `buildLiveGraphOutput` calls it for
 * both its in-process and off-process-worker producers. This test pins that the
 * live seam (`buildLiveGraphOutput`) applies the SAME waivers the static seam
 * does, against the SAME build root — so TTY and piped runs agree
 * finding-for-finding.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal, runWithScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { assertFinalizedAcrossBoundary } from '../apply-suppressions.js';
import { buildLiveGraphOutput } from '../graph-report.js';
import { dispatchGraphResult, persistSession } from '../graph.js';

import type { Catalog } from '../../types.js';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

// Capture the post-waiver signals the STATIC path hands the gate sink — the same
// interception the dispatch-suppression-root test uses. runGateMode receives the
// already-waived set as arg[1].
const runGateMode = vi.fn().mockResolvedValue(undefined);
vi.mock('../graph-modes.js', () => ({
  runGateMode: (...args: unknown[]) => runGateMode(...args),
  runCatalogJsonMode: vi.fn(),
}));

let buildRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  buildRoot = await mkdtemp(join(tmpdir(), 'graph-live-parity-'));
});

afterEach(async () => {
  await rm(buildRoot, { recursive: true, force: true });
});

/** A graph:large-function signal anchored at `file:line` (project-relative). */
function sig(file: string, line: number): Signal {
  return createSignal({
    source: 'graph',
    severity: 'medium',
    category: 'quality',
    ruleId: 'graph:large-function',
    message: `big at ${file}:${String(line)}`,
    code: { file, line },
  });
}

function emptyCatalog(): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode: 'exact',
    functions: {},
  };
}

function mockCli(): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    logger: console,
    scope: { signalSink: { emit: vi.fn() }, datastore: () => undefined },
  } as unknown as ToolCliContext;
}

/** The live-view producer's single seam → its waived signals. */
async function liveSignals(signals: readonly Signal[], root: string): Promise<readonly Signal[]> {
  const out = await runWithScope(makeGraphTestScope(), () =>
    buildLiveGraphOutput(
      { catalog: emptyCatalog(), indexes: null, signals, cacheHit: false },
      root,
    ),
  );
  return out.signals;
}

/** The static dispatch path's waived signals (captured at the gate sink). */
async function staticSignals(signals: readonly Signal[], root: string): Promise<readonly Signal[]> {
  const opts = { gateSave: true, cwd: root } as unknown as Parameters<
    typeof dispatchGraphResult
  >[0];
  const result = { signals, catalog: emptyCatalog() } as unknown as Parameters<
    typeof dispatchGraphResult
  >[1];
  await runWithScope(makeGraphTestScope(), () =>
    dispatchGraphResult(opts, result, mockCli(), '2026-06-09T00:00:00.000Z', root),
  );
  expect(runGateMode).toHaveBeenCalledTimes(1);
  // arg[1] is the post-waiver envelope runGateMode receives (ADR-0036).
  return (runGateMode.mock.calls[0]?.[1]?.signals ?? []) as readonly Signal[];
}

const fileOf = (signals: readonly Signal[]): string[] =>
  signals.map((s) => s.code?.file ?? '').sort();

describe('live-view suppression parity', () => {
  it('LIVE seam suppresses a signal whose @graph-ignore directive lives under the build root', async () => {
    await writeFile(
      join(buildRoot, 'walk.ts'),
      ['// @graph-ignore-next-line graph:large-function -- intentional', 'function big() {}'].join(
        '\n',
      ),
      'utf8',
    );

    const kept = await liveSignals([sig('walk.ts', 2)], buildRoot);

    // The live path applies the waiver — the TTY leak is closed.
    expect(kept).toHaveLength(0);
  });

  it('LIVE seam keeps a signal with no directive (nothing over-suppressed)', async () => {
    const kept = await liveSignals([sig('walk.ts', 2)], buildRoot);
    expect(kept).toHaveLength(1);
  });

  it('LIVE and STATIC seams produce the SAME waived set for the same directive + root', async () => {
    await writeFile(
      join(buildRoot, 'walk.ts'),
      ['// @graph-ignore-next-line graph:large-function -- intentional', 'function big() {}'].join(
        '\n',
      ),
      'utf8',
    );
    const signals = [sig('walk.ts', 2), sig('other.ts', 9)];

    const live = await liveSignals(signals, buildRoot);
    const stat = await staticSignals(signals, buildRoot);

    // Both waive walk.ts:2 (directive present) and keep other.ts:9 — identical.
    expect(fileOf(live)).toEqual(['other.ts']);
    expect(fileOf(stat)).toEqual(['other.ts']);
    expect(fileOf(live)).toEqual(fileOf(stat));
  });

  it('COMPILE-TIME guardrail: persistSession rejects raw, un-finalized signals', () => {
    const raw: readonly Signal[] = [sig('walk.ts', 2)];

    // The branded FinalizedSignals type is the structural guardrail: a future
    // 4th output path CANNOT persist un-waived signals because the compiler
    // rejects a raw `Signal[]` here. If this `@ts-expect-error` ever stops
    // erroring (someone widened persistSession back to `readonly Signal[]`), the
    // build fails — the leak class is re-openable only by deleting this guard.
    // @ts-expect-error — raw Signal[] is not assignable to FinalizedSignals
    // Updated for host-owned timing (phase 5): tests that directly exercised the old
    // 5-arg persist now use minimal (or the host record seam in prod paths). Legacy
    // persist still accepts the extra args for transition; real StoredSession timing
    // no longer comes from here.
    persistSession({ cwd: buildRoot }, raw, undefined, 0, '2026-01-01T00:00:00.000Z');

    // The ONLY way in is via the finalize seam (or its post-IPC re-brand assert),
    // which type-checks cleanly. `datastore: undefined` makes this a no-op call.
    const ok = persistSession(
      { cwd: buildRoot },
      assertFinalizedAcrossBoundary(raw, 0),
      undefined,
      0,
      '2026-01-01T00:00:00.000Z',
    );

    // The real assertion of this test is the `@ts-expect-error` above (a
    // compile-time guarantee). This runtime check just confirms the branded
    // call is the no-op we expect when datastore is absent.
    expect(ok).toBeUndefined();
  });
});
