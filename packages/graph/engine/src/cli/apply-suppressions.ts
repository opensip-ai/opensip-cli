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
