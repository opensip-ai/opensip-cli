/**
 * Target-convention TYPES for agent discovery surfaces. The runtime projection
 * (`summarizeTargetConventions`) lives in @opensip-cli/shared-analysis
 * (Plan 09 Phase 7); contracts keeps only the serializable shapes.
 */

/** Bounded convention counts for one target, safe for agent discovery surfaces. */
export interface TargetConventionSummary {
  /** Target name from `targets.<name>`. */
  readonly target: string;
  /** Number of configured graph entrypoint glob patterns. */
  readonly entrypointCount: number;
  /** Number of configured always-used file glob patterns. */
  readonly alwaysUsedCount: number;
  /** Number of configured export names across all used-export declarations. */
  readonly usedExportCount: number;
}

/** Optional project context attached to agent-facing discovery payloads. */
export interface AgentProjectContext {
  readonly targetConventions: readonly TargetConventionSummary[];
}
