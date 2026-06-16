/**
 * Canonical bootstrap phase names (ADR-0052). The hook is the Commander
 * adapter; business rules live behind the planner and post-bailout executor.
 */

export const PRE_ACTION_PHASES = {
  readCommandOptions: 'read-command-options',
  mergeCliDefaults: 'merge-cli-defaults',
  resolveProject: 'resolve-project',
  bailoutWindow: 'bailout-window',
  projectSideEffects: 'project-side-effects',
  buildScope: 'build-scope',
  enterScope: 'enter-scope',
  hostStartEffects: 'host-start-effects',
  toolPreflight: 'tool-preflight',
  dispose: 'dispose',
} as const;

export type PreActionPhase = (typeof PRE_ACTION_PHASES)[keyof typeof PRE_ACTION_PHASES];

/** Post-bailout phases in load-bearing order (phases 5–9 of ADR-0052). */
export const POST_BAILOUT_PHASE_ORDER: readonly PreActionPhase[] = [
  PRE_ACTION_PHASES.projectSideEffects,
  PRE_ACTION_PHASES.buildScope,
  PRE_ACTION_PHASES.enterScope,
  PRE_ACTION_PHASES.hostStartEffects,
  PRE_ACTION_PHASES.toolPreflight,
] as const;
