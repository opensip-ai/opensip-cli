import type { TargetResolver } from '@opensip-cli/core';

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

/** Project target convention projection that never expands file globs. */
export function summarizeTargetConventions(
  targets: TargetResolver | undefined,
): readonly TargetConventionSummary[] {
  const summaries: TargetConventionSummary[] = [];
  for (const target of targets?.getAll() ?? []) {
    const conventions = target.config.conventions;
    if (!conventions) continue;
    const entrypointCount = conventions.entrypoints?.length ?? 0;
    const alwaysUsedCount = conventions.alwaysUsed?.length ?? 0;
    const usedExportCount = (conventions.usedExports ?? []).reduce(
      (total, entry) => total + entry.names.length,
      0,
    );
    if (entrypointCount === 0 && alwaysUsedCount === 0 && usedExportCount === 0) continue;
    summaries.push({
      target: target.config.name,
      entrypointCount,
      alwaysUsedCount,
      usedExportCount,
    });
  }
  return summaries;
}
