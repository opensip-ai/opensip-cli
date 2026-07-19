/**
 * Target-convention RUNTIME projection for agent discovery surfaces. The
 * serializable shapes (TargetConventionSummary, AgentProjectContext) live in
 * @opensip-cli/contracts.
 */
import type { TargetConventionSummary } from '@opensip-cli/contracts';
import type { TargetResolver } from '@opensip-cli/core';

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
