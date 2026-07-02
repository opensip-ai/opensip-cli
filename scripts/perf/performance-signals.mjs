export function signalsFromComparisons(comparisons, profile) {
  return comparisons
    .filter((comparison) => comparison.status === 'fail')
    .map((comparison) => ({
      source: 'performance-slo',
      provider: 'opensip-cli',
      category: 'performance',
      severity: comparison.metric === 'exitCode' ? 'high' : 'medium',
      ruleId: `performance-slo:${comparison.scenario}:${comparison.metric}`,
      message: `Performance SLO failed for ${comparison.tier}/${comparison.scenario}: ${comparison.message}`,
      location: {
        filePath: '.config/performance-slos.json',
        startLine: 1,
        startColumn: 1,
      },
      metadata: {
        profile,
        tier: comparison.tier,
        scenario: comparison.scenario,
        metric: comparison.metric,
        actual: comparison.actual,
        budget: comparison.budget,
        ratio: comparison.ratio,
      },
    }));
}
