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
import { buildLiveGraphOutput } from '../graph-report.js';
import { dispatchGraphResult } from '../graph.js';

import type { GraphSessionPayload } from '../../persistence/session-payload.js';
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
    reportFailure: vi.fn(() => Promise.resolve()),
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

  it('the returned session contribution is built from the WAIVED set (host-owned-run-timing Phase 3)', async () => {
    // host-owned-run-timing Phase 3: graph no longer writes the generic session
    // row itself — `dispatchGraphResult` RETURNS a `GraphRunOutcome.session` and
    // the host persists it. The branding guardrail is preserved INSIDE
    // `deliverGraphResult`: the contribution is built from the branded
    // `FinalizedSignals`, so the session payload can only ever carry post-waiver
    // findings. This pins that the default-render outcome's session reflects the
    // waiver (walk.ts:2 suppressed; other.ts:9 kept).
    await writeFile(
      join(buildRoot, 'walk.ts'),
      ['// @graph-ignore-next-line graph:large-function -- intentional', 'function big() {}'].join(
        '\n',
      ),
      'utf8',
    );
    const signals = [sig('walk.ts', 2), sig('other.ts', 9)];

    const opts = { cwd: buildRoot } as unknown as Parameters<typeof dispatchGraphResult>[0];
    const result = {
      signals,
      catalog: emptyCatalog(),
    } as unknown as Parameters<typeof dispatchGraphResult>[1];
    const outcome = await runWithScope(makeGraphTestScope(), () =>
      dispatchGraphResult(opts, result, mockCli(), '2026-06-09T00:00:00.000Z', buildRoot),
    );

    const payload = outcome?.session?.payload as GraphSessionPayload | undefined;
    expect(payload).toBeDefined();
    // Exactly one finding survives the waiver (other.ts:9) and lands in the
    // payload's rule-grouped detail; walk.ts:2 was suppressed before the build.
    const allFindings = (payload?.checks ?? []).flatMap((c) => c.findings);
    expect(allFindings.map((f) => f.filePath)).toEqual(['other.ts']);
  });
});
