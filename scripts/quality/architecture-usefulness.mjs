export function scoreArchitectureUsefulness(scenarios, thresholds) {
  const rows = scenarios.map((scenario) => {
    const observed = observedDecisionChange(scenario);
    return {
      id: scenario.id,
      label: scenario.label,
      expected: scenario.expected,
      observed,
      passed: observed === scenario.expected,
      rationale: scenario.rationale,
    };
  });
  const total = rows.length;
  const contextChangesDecision = rows.filter(
    (row) => row.observed === 'context_changes_decision',
  ).length;
  const contextDoesNotChangeDecision = rows.filter(
    (row) => row.observed === 'context_does_not_change_decision',
  ).length;
  const inconclusive = rows.filter((row) => row.observed === 'inconclusive').length;
  const decisionChangeRate = total === 0 ? null : contextChangesDecision / total;
  const verdict =
    total >= thresholds.minArchitectureScenarios &&
    decisionChangeRate !== null &&
    decisionChangeRate >= thresholds.minArchitectureDecisionChangeRate &&
    rows.every((row) => row.passed)
      ? 'pass'
      : 'fail';
  return {
    total,
    contextChangesDecision,
    contextDoesNotChangeDecision,
    inconclusive,
    decisionChangeRate,
    verdict,
    rows,
  };
}

function observedDecisionChange(scenario) {
  if (scenario.contextDecision === 'unknown') return 'inconclusive';
  return scenario.rawDecision === scenario.contextDecision
    ? 'context_does_not_change_decision'
    : 'context_changes_decision';
}
