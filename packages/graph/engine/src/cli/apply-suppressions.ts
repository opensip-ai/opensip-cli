/**
 * @fileoverview Graph inline-suppression application (ADR-0014).
 *
 * Binds the shared core suppression primitive to graph's explicit
 * `@graph-ignore-file` / `@graph-ignore-next-line` directives, applied to a
 * run's signals before they reach the gate baseline, the dashboard, or render.
 * Suppression is unconditional (a directive with no `-- reason` still
 * suppresses); reason quality is audited out-of-band by `graph-ignore-hygiene`.
 *
 * `graph:cycle` is one-signal-per-SCC anchored at a computed member, so a
 * directive above ANY member must waive it — graph's `locate()` feeds the
 * SCC's `memberLocations` (attached in `rules/cycle.ts`) as candidate
 * locations. Every other rule falls back to the signal's own anchor.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { filterSignalsBySuppressions } from '@opensip-tools/core';

import type { Signal, SuppressionKeywords, SuppressionLocation } from '@opensip-tools/core';

const GRAPH_KEYWORDS: SuppressionKeywords = {
  file: '@graph-ignore-file',
  nextLine: '@graph-ignore-next-line',
};

export interface GraphSuppressionOutcome {
  readonly kept: readonly Signal[];
  readonly suppressedCount: number;
}

/**
 * Phantom brand stamped onto a signal set that has crossed the single
 * suppression chokepoint ({@link finalizeGraphSignals}). It carries no runtime
 * data — `FINALIZED_BRAND` is a compile-time-only marker — so a `FinalizedSignals`
 * serializes to a plain `{ signals, suppressedCount }` object across the worker
 * IPC boundary, yet the type system forbids constructing one anywhere except the
 * seam below.
 */
declare const FINALIZED_BRAND: unique symbol;

/**
 * The run's signal set AFTER `@graph-ignore` waivers have been applied — the
 * ONLY signal shape that may be persisted, verdict-computed, or rendered.
 *
 * Structural-typing escape hatch closed via the {@link FINALIZED_BRAND} phantom:
 * a raw `readonly Signal[]` is NOT assignable to `FinalizedSignals`, and the
 * brand can only be minted by {@link finalizeGraphSignals}. A future fourth
 * output path therefore CANNOT hand un-waived signals to the persist / verdict /
 * render functions — the compiler rejects it. This is the structural guardrail
 * that makes the TTY-leak class of bug (suppression applied on one path only)
 * un-regressable rather than patched.
 */
export interface FinalizedSignals {
  readonly signals: readonly Signal[];
  readonly suppressedCount: number;
  readonly [FINALIZED_BRAND]: true;
}

/**
 * THE single suppression/finalize chokepoint. Apply `@graph-ignore` waivers to a
 * run's raw engine signals and brand the result {@link FinalizedSignals}. Every
 * output path — the static `dispatchGraphResult` family AND the live-view
 * in-process + off-process-worker producers (via `buildLiveGraphOutput`) — MUST
 * route through here; the branded return type is what enforces "one build → one
 * finalize → many renderers" at compile time.
 *
 * `buildRoot` is the directory the signals' project-relative `code.file` paths
 * are RELATIVE TO (the positional subtree / sharded-child / workspace-unit root,
 * not necessarily `opts.cwd`). Resolving against the wrong base makes every
 * directive file unreadable (ENOENT) and silently leaks the waiver — the
 * `743fab98` class of regression.
 */
export async function finalizeGraphSignals(
  rawSignals: readonly Signal[],
  buildRoot: string,
): Promise<FinalizedSignals> {
  const { kept, suppressedCount } = await applyGraphSuppressions(rawSignals, buildRoot);
  return brandFinalized(kept, suppressedCount);
}

/**
 * Re-establish the {@link FinalizedSignals} brand on a signal set that has
 * ALREADY crossed {@link finalizeGraphSignals} but lost its phantom brand by
 * crossing a serialization boundary (the off-process graph worker streams back a
 * plain `{ signals, suppressedCount }` payload over IPC). This is NOT a second
 * suppression entry point — it ASSERTS a prior finalize, it does not perform one
 * — so the "one seam" invariant holds: the worker finalizes once inside itself,
 * and the parent merely re-stamps the brand the structured-clone dropped.
 *
 * @internal
 */
export function assertFinalizedAcrossBoundary(
  signals: readonly Signal[],
  suppressedCount: number,
): FinalizedSignals {
  return brandFinalized(signals, suppressedCount);
}

function brandFinalized(signals: readonly Signal[], suppressedCount: number): FinalizedSignals {
  return { signals, suppressedCount } as FinalizedSignals;
}

/**
 * Apply `@graph-ignore` waivers to a run's signals. `projectRoot` resolves the
 * project-relative `code.file` paths the signals carry.
 *
 * Read-failure posture (ADR-0014 + fail-loud Phase 5): the core primitive is
 * fail-loud. A genuinely-removed (`ENOENT`) directive file is non-fatal but
 * attributed (the primitive logs `signals.suppress.directive-file-missing`);
 * ANY other read failure PROPAGATES. This function deliberately does NOT
 * catch it — the error reaches the CLI error boundary, which classifies it and
 * exits, rather than letting a dropped waiver leak a signal as a finding.
 */
export async function applyGraphSuppressions(
  signals: readonly Signal[],
  projectRoot: string,
): Promise<GraphSuppressionOutcome> {
  const readFile = (file: string): Promise<string> =>
    fsReadFile(resolvePath(projectRoot, file), 'utf8');
  const { kept, suppressed } = await filterSignalsBySuppressions({
    signals,
    keywords: GRAPH_KEYWORDS,
    readFile,
    locate: graphLocate,
  });
  return { kept, suppressedCount: suppressed.length };
}

/** Candidate locations a `@graph-ignore` directive may target for `signal`. */
function graphLocate(signal: Signal): readonly SuppressionLocation[] {
  const members = signal.metadata.memberLocations;
  if (Array.isArray(members)) {
    const locations: SuppressionLocation[] = [];
    for (const member of members) {
      if (isLocation(member)) locations.push({ file: member.file, line: member.line });
    }
    if (locations.length > 0) return locations;
  }
  const file = signal.code?.file;
  if (file === undefined) return [];
  return [{ file, line: signal.code?.line }];
}

function isLocation(value: unknown): value is { file: string; line: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { file?: unknown }).file === 'string' &&
    typeof (value as { line?: unknown }).line === 'number'
  );
}
