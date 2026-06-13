/**
 * Regression: `dispatchGraphResult` must waive `@graph-ignore` directives
 * against the BUILD ROOT the signals are relative to (`suppressionRoot`), NOT
 * `opts.cwd`.
 *
 * The two coincide for a bare `graph` run, but diverge for `graph <subdir>` and
 * for every `--workspace` child (which runs `graph <unitRoot> --json` with cwd
 * inherited from the parent = repo root). The old code resolved directive files
 * against `opts.cwd`, so a child's package-relative `code.file` never found its
 * directive on disk (ENOENT) and the waiver silently leaked — reproducing the
 * cycle/large-function warnings that the single-program run correctly suppresses.
 *
 * These tests drive the public `dispatchGraphResult` seam with `opts.cwd` set to
 * a directory that does NOT contain the directive, and `suppressionRoot` set to
 * the temp dir that does. The signal must be suppressed via `suppressionRoot`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchGraphResult } from '../graph.js';

import type { Signal, ToolCliContext } from '@opensip-cli/core';

// Capture the signals each output mode receives. runGateMode is the simplest
// sink to assert against (it takes the post-waiver signals as arg[1]).
const runGateMode = vi.fn().mockResolvedValue(undefined);
vi.mock('../graph-modes.js', () => ({
  runGateMode: (...args: unknown[]) => runGateMode(...args),
  runCatalogJsonMode: vi.fn(),
}));

let buildRoot: string;
let otherCwd: string;

beforeEach(async () => {
  vi.clearAllMocks();
  buildRoot = await mkdtemp(join(tmpdir(), 'graph-disp-root-'));
  otherCwd = await mkdtemp(join(tmpdir(), 'graph-disp-cwd-'));
});

afterEach(async () => {
  await rm(buildRoot, { recursive: true, force: true });
  await rm(otherCwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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

function gateOpts(cwd: string) {
  return { gateSave: true, cwd } as unknown as Parameters<typeof dispatchGraphResult>[0];
}

const result = (signals: readonly Signal[]): Parameters<typeof dispatchGraphResult>[1] =>
  ({ signals, catalog: undefined }) as unknown as Parameters<typeof dispatchGraphResult>[1];

const STARTED = '2026-06-07T00:00:00.000Z';

describe('dispatchGraphResult — waives against suppressionRoot, not opts.cwd', () => {
  it('suppresses a signal whose directive lives under suppressionRoot (≠ opts.cwd)', async () => {
    // The directive file exists ONLY under buildRoot. opts.cwd points elsewhere
    // (the repo-root stand-in a --workspace child inherits). The waiver must
    // still apply — it is resolved against suppressionRoot.
    await writeFile(
      join(buildRoot, 'walk.ts'),
      ['// @graph-ignore-next-line graph:large-function -- intentional', 'function big() {}'].join(
        '\n',
      ),
      'utf8',
    );

    await dispatchGraphResult(
      gateOpts(otherCwd),
      result([sig('walk.ts', 2)]),
      mockCli(),
      STARTED,
      buildRoot,
    );

    expect(runGateMode).toHaveBeenCalledTimes(1);
    // arg[1] is the post-waiver envelope runGateMode receives (ADR-0036).
    expect(runGateMode.mock.calls[0]?.[1]?.signals).toHaveLength(0);
  });

  it('does NOT suppress when only opts.cwd (the wrong base) holds the directive', async () => {
    // The directive sits under opts.cwd, NOT the build root. Resolving against
    // opts.cwd (the old behavior) would suppress; resolving against
    // suppressionRoot (correct) must KEEP the signal — pinning the base used.
    await writeFile(
      join(otherCwd, 'walk.ts'),
      ['// @graph-ignore-next-line graph:large-function -- wrong base', 'function big() {}'].join(
        '\n',
      ),
      'utf8',
    );

    await dispatchGraphResult(
      gateOpts(otherCwd),
      result([sig('walk.ts', 2)]),
      mockCli(),
      STARTED,
      buildRoot,
    );

    expect(runGateMode).toHaveBeenCalledTimes(1);
    // The waiver under opts.cwd must NOT apply — the signal survives.
    expect(runGateMode.mock.calls[0]?.[1]?.signals).toHaveLength(1);
  });
});
