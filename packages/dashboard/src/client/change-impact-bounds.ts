/** Defensive browser-render caps for already bounded, embedded report evidence. */
export const CHANGE_IMPACT_CLIENT_CAPS = {
  actions: 50,
  changedFiles: 100,
  changedFunctions: 100,
  correlations: 50,
  correlationMembers: 50,
  correlationReasons: 20,
  degradations: 50,
  impactedFiles: 100,
  impactedFunctions: 100,
  impactedPackages: 100,
  recommendedCommands: 20,
  risks: 100,
  /** Separate client cap for the stored newFindings list (can diverge from topRisks). */
  newFindings: 100,
  uncertainties: 100,
} as const;

export interface BoundedClientRows<T> {
  readonly rows: readonly T[];
  readonly omitted: number;
}

export function boundClientRows<T>(values: readonly T[], cap: number): BoundedClientRows<T> {
  return {
    rows: values.slice(0, cap),
    omitted: Math.max(0, values.length - cap),
  };
}

/** Count rows suppressed only by the browser's final defensive render guard. */
export function clientOmittedRowCount(model: ChangeImpactViewModel): number {
  const evidence = model.evidence;
  const brief = model.reviewBrief;
  const lengths = [
    [evidence?.changedFiles.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.changedFiles],
    [evidence?.changedFunctions.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.changedFunctions],
    [evidence?.impactedFunctions.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.impactedFunctions],
    [evidence?.impactedFiles.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.impactedFiles],
    [evidence?.impactedPackages.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.impactedPackages],
    [evidence?.recommendedCommands.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.recommendedCommands],
    [evidence?.trust.uncertainties.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.uncertainties],
    [brief?.topRisks.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.risks],
    [brief?.newFindings.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.newFindings],
    [brief?.correlatedRisks?.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.correlations],
    [brief?.recommendedActions.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.actions],
    [brief?.degraded.length ?? 0, CHANGE_IMPACT_CLIENT_CAPS.degradations],
  ] as const;
  const topLevel = lengths.reduce((total, [length, cap]) => total + Math.max(0, length - cap), 0);
  const nested = (brief?.correlatedRisks ?? [])
    .slice(0, CHANGE_IMPACT_CLIENT_CAPS.correlations)
    .reduce(
      (total, group) =>
        total +
        Math.max(0, group.members.length - CHANGE_IMPACT_CLIENT_CAPS.correlationMembers) +
        Math.max(0, group.reasons.length - CHANGE_IMPACT_CLIENT_CAPS.correlationReasons),
      0,
    );
  return topLevel + nested;
}
