import { budgetKey } from './slo-config.mjs';

export function compareBudgets(report, config, opts = {}) {
  if (report.measurementMode !== undefined && report.measurementMode !== 'clean-wall') {
    throw new Error(
      `Performance budgets require measurementMode 'clean-wall'; received '${String(report.measurementMode)}'.`,
    );
  }
  const comparisons = [];
  for (const scenario of report.scenarios) {
    if (scenario.skipped === true) continue;
    comparisons.push(compareExitCode(scenario));
    const budget = config.budgetByKey.get(budgetKey(scenario.tier, scenario.scenario));
    if (budget === undefined) continue;

    comparisons.push(
      compareMetric(scenario, budget, 'durationMs', scenario.durationMs, budget.maxDurationMs),
      compareMetric(scenario, budget, 'maxRssBytes', scenario.maxRssBytes, budget.maxRssBytes, {
        requireValue: opts.requireMemory === true,
      }),
    );
  }
  return comparisons;
}

function compareExitCode(scenario) {
  const passed = scenario.status === 0 && scenario.timedOut !== true;
  const status = passed ? 'pass' : 'fail';
  const suffix = scenario.timedOut ? ' after timeout' : '';
  const message = passed
    ? 'command exited successfully'
    : `command exited with ${String(scenario.status)}${suffix}`;
  return {
    tier: scenario.tier,
    scenario: scenario.scenario,
    metric: 'exitCode',
    actual: scenario.status,
    budget: 0,
    ratio: passed ? 0 : 1,
    status,
    message,
  };
}

function compareMetric(scenario, budget, metric, actual, limit, options = {}) {
  if (actual === undefined) {
    return {
      tier: scenario.tier,
      scenario: scenario.scenario,
      metric,
      actual: undefined,
      budget: limit,
      ratio: undefined,
      status: options.requireValue === true ? 'fail' : 'not-measured',
      message: `${metric} was not measured`,
    };
  }
  const ratio = actual / limit;
  let status = 'pass';
  if (ratio > 1) {
    status = 'fail';
  } else if (ratio >= 0.9) {
    status = 'warn';
  }
  return {
    tier: scenario.tier,
    scenario: scenario.scenario,
    metric,
    actual,
    budget: metric === 'durationMs' ? budget.maxDurationMs : budget.maxRssBytes,
    ratio,
    status,
    message: `${metric} ${String(actual)} / ${String(limit)}`,
  };
}
