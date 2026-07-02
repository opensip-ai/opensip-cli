export function compareQualityBaseline(report, baseline, config) {
  const comparisons = [];
  if (baseline.version !== 1) {
    comparisons.push(
      fail('baseline', 'version', `unsupported baseline version ${String(baseline.version)}`),
    );
  }
  if (baseline.profile !== report.profile) {
    comparisons.push(
      fail(
        'baseline',
        'profile',
        `baseline profile ${baseline.profile} != report profile ${report.profile}`,
      ),
    );
  }
  if (baseline.configHash !== report.configHash) {
    comparisons.push(fail('baseline', 'configHash', 'baseline config hash is stale'));
  }
  for (const language of config.requiredLanguages) {
    const support = report.corpus.languages[language] ?? 0;
    if (support <= 0) {
      comparisons.push(
        fail('corpus', language, `required language ${language} has no corpus cases`),
      );
    }
  }

  for (const [slug, row] of Object.entries(report.metricsByCheck)) {
    const previous = baseline.metricsByCheck?.[slug];
    if (!previous) {
      comparisons.push(
        pass(slug, 'support', `new measured check with support ${String(row.support)}`),
      );
      thresholdChecks(comparisons, slug, row, config);
      continue;
    }
    compareRate(
      comparisons,
      slug,
      'precision',
      row.precision,
      previous.precision,
      -config.thresholds.precisionDropTolerance,
    );
    compareRate(
      comparisons,
      slug,
      'recall',
      row.recall,
      previous.recall,
      -config.thresholds.recallDropTolerance,
    );
    compareRate(
      comparisons,
      slug,
      'fpr',
      row.fpr,
      previous.fpr,
      config.thresholds.fprIncreaseTolerance,
    );
    const supportDrop = previous.support - row.support;
    if (supportDrop > config.thresholds.supportDropTolerance) {
      comparisons.push(fail(slug, 'support', `support dropped by ${String(supportDrop)}`));
    }
    thresholdChecks(comparisons, slug, row, config);
  }

  for (const slug of Object.keys(baseline.metricsByCheck ?? {})) {
    if (report.metricsByCheck[slug] === undefined) {
      comparisons.push(
        fail(slug, 'missing', 'check was present in baseline but not in current report'),
      );
    }
  }

  const arch = report.architectureUsefulness;
  if (arch.verdict === 'fail') {
    comparisons.push(
      fail('architecture-usefulness', 'verdict', 'architecture usefulness thresholds failed'),
    );
  }
  return comparisons.length === 0
    ? [pass('quality', 'all', 'all detection quality comparisons passed')]
    : comparisons;
}

function thresholdChecks(comparisons, slug, row, config) {
  if (row.precision !== null && row.precision < config.thresholds.minPrecision) {
    comparisons.push(
      fail(
        slug,
        'precision',
        `precision ${format(row.precision)} below minimum ${format(config.thresholds.minPrecision)}`,
      ),
    );
  }
  if (row.recall !== null && row.recall < config.thresholds.minRecall) {
    comparisons.push(
      fail(
        slug,
        'recall',
        `recall ${format(row.recall)} below minimum ${format(config.thresholds.minRecall)}`,
      ),
    );
  }
  if (row.fpr !== null && row.fpr > config.thresholds.maxFpr) {
    comparisons.push(
      fail(slug, 'fpr', `FPR ${format(row.fpr)} above maximum ${format(config.thresholds.maxFpr)}`),
    );
  }
}

function compareRate(comparisons, slug, metric, current, previous, tolerance) {
  if (current === null || previous === null) return;
  const delta = current - previous;
  if (metric === 'fpr') {
    if (delta > tolerance)
      comparisons.push(fail(slug, metric, `${metric} increased by ${format(delta)}`));
  } else if (delta < tolerance) {
    comparisons.push(fail(slug, metric, `${metric} dropped by ${format(Math.abs(delta))}`));
  }
}

function pass(slug, metric, message) {
  return { slug, metric, status: 'pass', message };
}

function fail(slug, metric, message) {
  return { slug, metric, status: 'fail', message };
}

function format(value) {
  return value.toFixed(3);
}
