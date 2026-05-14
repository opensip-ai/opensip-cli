/**
 * sim command — run simulation scenarios
 */

import type { CliArgs, ExperimentalResult } from '@opensip-tools/cli-shared';

const VALID_KINDS = new Set(['load', 'chaos', 'invariant', 'fix-evaluation']);

// ---------------------------------------------------------------------------
// executeSim
// ---------------------------------------------------------------------------

export function executeSim(args: CliArgs): ExperimentalResult {
  const result: ExperimentalResult = {
    type: 'experimental',
    tool: 'sim',
    cwd: args.cwd,
  };
  // The `--kind` filter is wired through the result so future scenario-execution
  // surfaces (Phase 7+) can dispatch to per-kind runners. Phase 0b.5 only ships
  // the wire-up; the experimental notice is unchanged.
  if (args.kind && VALID_KINDS.has(args.kind)) {
    result.kind = args.kind;
  }
  return result;
}
