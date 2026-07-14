import { compareBudgets } from '../perf/compare-budgets.mjs';
import { budgetKey } from '../perf/slo-config.mjs';

const GIT_OBJECT_ID_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;

export function normalizeBenchmarkSnapshot(raw, sourcePath = '<memory>') {
  if (!isRecord(raw)) {
    throw new Error(`Invalid benchmark snapshot at ${sourcePath}: root must be an object.`);
  }
  if (raw.version !== 1) {
    throw new Error(`Invalid benchmark snapshot at ${sourcePath}: version must be 1.`);
  }

  const snapshot = {
    version: 1,
    reportKind: optionalString(raw.reportKind),
    source: stringValue(raw.source, 'source'),
    createdAt: stringValue(raw.createdAt, 'createdAt'),
    measurementMode: stringValue(raw.measurementMode, 'measurementMode'),
    profile: stringValue(raw.profile, 'profile'),
    quick: booleanValue(raw.quick, 'quick'),
    verdict: stringValue(raw.verdict, 'verdict'),
    config: normalizeSnapshotConfig(raw.config),
    environment: normalizeEnvironment(raw.environment),
    corpora: normalizeCorpora(raw.corpora),
    scenarios: normalizeScenarios(raw.scenarios),
    budgets: normalizeBudgetRows(raw.budgets),
  };
  assertPublishableSnapshot(snapshot);
  return snapshot;
}

export function snapshotFromSloReport(report, options = {}) {
  if (!isRecord(report)) throw new Error('Invalid SLO report: root must be an object.');
  assertPublishableSloReport(report);
  const snapshot = {
    version: 1,
    reportKind: 'opensip-performance-slo',
    source: options.source ?? `pnpm bench:slo -- --profile ${String(report.profile ?? 'pr')}`,
    createdAt: stringValue(report.createdAt, 'createdAt'),
    measurementMode: 'clean-wall',
    profile: stringValue(report.profile, 'profile'),
    quick: booleanValue(report.quick, 'quick'),
    verdict: stringValue(report.verdict, 'verdict'),
    config: normalizeSnapshotConfig(report.config),
    environment: normalizeEnvironment(report.environment),
    corpora: normalizeCorpora(report.corpora).map((corpus) => ({
      tier: corpus.tier,
      fileCount: corpus.fileCount,
      changedFiles: corpus.changedFiles,
      changedFileCount: corpus.changedFileCount,
      gitReady: corpus.gitReady,
      contentSha256: corpus.contentSha256,
    })),
    scenarios: normalizeScenarios(report.scenarios).map((scenario) => ({
      tier: scenario.tier,
      scenario: scenario.scenario,
      label: scenario.label,
      status: scenario.status,
      timedOut: scenario.timedOut,
      durationMs: scenario.durationMs,
      maxRssBytes: scenario.maxRssBytes,
      graphProfile: scenario.graphProfile,
      skipped: scenario.skipped,
      skipReason: scenario.skipReason,
    })),
    budgets: normalizeBudgetRows(report.budgets),
  };
  const normalized = normalizeBenchmarkSnapshot(snapshot);
  if (options.sloConfig !== undefined) {
    assertSnapshotMatchesConfig(normalized, options.sloConfig);
  }
  return normalized;
}

function assertPublishableSloReport(report) {
  if (report.kind !== 'opensip-performance-slo') {
    throw new Error('Public benchmark snapshots require an opensip-performance-slo report.');
  }
  if (report.measurementMode !== 'clean-wall') {
    throw new Error('Public benchmark snapshots require measurementMode "clean-wall".');
  }
  assertPublishableFields({
    reportKind: report.kind,
    profile: report.profile,
    quick: report.quick,
    verdict: report.verdict,
    config: report.config,
    environment: report.environment,
    corpora: report.corpora,
    scenarios: report.scenarios,
    budgets: report.budgets,
    otlpExport: report.otlpExport,
  });
}

function assertPublishableSnapshot(snapshot) {
  if (snapshot.measurementMode !== 'clean-wall') {
    throw new Error('Public benchmark snapshots require measurementMode "clean-wall".');
  }
  assertPublishableFields(snapshot);
}

function assertPublishableFields(value) {
  if (value.reportKind !== 'opensip-performance-slo') {
    throw new Error('Public benchmark snapshots require reportKind opensip-performance-slo.');
  }
  if (value.profile !== 'pr') {
    throw new Error('Public benchmark snapshots require the pr profile.');
  }
  if (value.quick !== false) {
    throw new Error('Public benchmark snapshots require a non-quick report.');
  }
  if (value.verdict !== 'pass') {
    throw new Error('Public benchmark snapshots require a passing report.');
  }
  if (value.otlpExport === true) {
    throw new Error('Public benchmark snapshots must not contain OTLP-export measurements.');
  }
  if (!/^v?24\./u.test(String(value.environment?.node ?? ''))) {
    throw new Error('Public benchmark snapshots require a Node 24 report.');
  }
  for (const key of ['pnpm', 'arch', 'platform', 'release', 'cpuModel', 'gitBranch']) {
    const fact = optionalString(value.environment?.[key]);
    if (
      fact === undefined ||
      fact.trim().length === 0 ||
      fact.trim().toLowerCase() === 'unavailable'
    ) {
      throw new Error(`Public benchmark snapshots require environment.${key}.`);
    }
  }
  if (!GIT_OBJECT_ID_PATTERN.test(String(value.environment?.gitSha ?? ''))) {
    throw new Error('Public benchmark snapshots require a 40- or 64-hex environment.gitSha.');
  }
  if (value.environment?.gitDirty !== false) {
    throw new Error('Public benchmark snapshots require a clean Git worktree.');
  }
  if (value.environment?.ci !== false) {
    throw new Error('Public benchmark snapshots require a non-CI reference run.');
  }
  if (!/^[a-f\d]{64}$/u.test(String(value.config?.fingerprint ?? ''))) {
    throw new Error('Public benchmark snapshots require a 64-hex config.fingerprint.');
  }
  if (!Array.isArray(value.corpora) || value.corpora.length === 0) {
    throw new Error('Public benchmark snapshots require at least one corpus.');
  }
  if (value.corpora.some((corpus) => !/^[a-f\d]{64}$/u.test(corpus?.contentSha256 ?? ''))) {
    throw new Error('Public benchmark snapshots require a 64-hex corpus contentSha256.');
  }
  if (value.corpora.some((corpus) => !Array.isArray(corpus?.changedFiles))) {
    throw new Error('Public benchmark snapshots require exact corpus changedFiles.');
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error('Public benchmark snapshots require at least one scenario.');
  }
  if (
    value.scenarios.some(
      (scenario) =>
        scenario?.skipped === true || scenario?.timedOut === true || scenario?.status !== 0,
    )
  ) {
    throw new Error('Public benchmark snapshots reject skipped, timed-out, or failed scenarios.');
  }
  if (
    !Array.isArray(value.budgets) ||
    value.budgets.length === 0 ||
    value.budgets.some((row) => row?.status !== 'pass')
  ) {
    throw new Error('Public benchmark snapshots require passing budget rows.');
  }
  const budgetKeys = new Set(
    value.budgets.map((row) => `${String(row.tier)}:${String(row.scenario)}:${String(row.metric)}`),
  );
  for (const scenario of value.scenarios) {
    for (const metric of ['exitCode', 'durationMs', 'maxRssBytes']) {
      const key = `${String(scenario.tier)}:${String(scenario.scenario)}:${metric}`;
      if (!budgetKeys.has(key)) {
        throw new Error(`Public benchmark snapshots require passing budget coverage for ${key}.`);
      }
    }
  }
}

export function rowsFromSnapshot(snapshot, sloConfig) {
  const normalized = normalizeBenchmarkSnapshot(snapshot);
  assertSnapshotMatchesConfig(normalized, sloConfig);
  const comparisonsByKey = new Map();
  for (const comparison of normalized.budgets) {
    comparisonsByKey.set(
      comparisonKey(comparison.tier, comparison.scenario, comparison.metric),
      comparison,
    );
  }

  return normalized.scenarios.map((scenario) => {
    const durationBudget =
      comparisonsByKey.get(comparisonKey(scenario.tier, scenario.scenario, 'durationMs')) ??
      budgetFromConfig(sloConfig, scenario.tier, scenario.scenario, 'durationMs');
    const rssBudget =
      comparisonsByKey.get(comparisonKey(scenario.tier, scenario.scenario, 'maxRssBytes')) ??
      budgetFromConfig(sloConfig, scenario.tier, scenario.scenario, 'maxRssBytes');
    const exitCode =
      comparisonsByKey.get(comparisonKey(scenario.tier, scenario.scenario, 'exitCode'))?.status ??
      'unknown';

    return {
      tier: scenario.tier,
      scenario: scenario.scenario,
      label: sloConfig.scenarios[scenario.scenario]?.label ?? scenario.label ?? scenario.scenario,
      status: scenario.skipped === true ? 'skipped' : statusFromScenario(scenario, exitCode),
      skipReason: scenario.skipReason,
      durationMs: scenario.durationMs,
      durationBudgetMs: durationBudget?.budget,
      durationStatus: durationBudget?.status,
      durationMarginMs: margin(durationBudget?.budget, scenario.durationMs),
      maxRssBytes: scenario.maxRssBytes,
      rssBudgetBytes: rssBudget?.budget,
      rssStatus: rssBudget?.status,
      rssMarginBytes: margin(rssBudget?.budget, scenario.maxRssBytes),
      graphCache: scenario.graphProfile?.cache,
      graphFiles: scenario.graphProfile?.files,
      graphFunctions: scenario.graphProfile?.functions,
    };
  });
}

function assertSnapshotMatchesConfig(snapshot, sloConfig) {
  if (snapshot.config?.fingerprint !== sloConfig.fingerprint) {
    throw new Error(
      'Public benchmark snapshot config fingerprint does not match .config/performance-slos.json.',
    );
  }
  assertCompleteProfileCoverage(snapshot, sloConfig);
  assertBudgetIntegrity(snapshot, sloConfig);
}

function assertBudgetIntegrity(snapshot, sloConfig) {
  const expectedRows = compareBudgets(
    { measurementMode: 'clean-wall', scenarios: snapshot.scenarios },
    sloConfig,
    { requireMemory: true },
  );
  const expectedByKey = new Map(
    expectedRows.map((row) => [comparisonKey(row.tier, row.scenario, row.metric), row]),
  );
  for (const row of snapshot.budgets) {
    const key = comparisonKey(row.tier, row.scenario, row.metric);
    const expected = expectedByKey.get(key);
    if (expected === undefined) {
      throw new Error(`Public benchmark snapshot has no configured budget for ${key}.`);
    }
    for (const field of ['actual', 'budget', 'ratio', 'status']) {
      if (!Object.is(row[field], expected[field])) {
        throw new Error(
          `Public benchmark snapshot budget ${key} ${field} does not match the measured scenario ` +
            `and loaded SLO config (recorded=${String(row[field])}; ` +
            `expected=${String(expected[field])}).`,
        );
      }
    }
  }
}

function assertCompleteProfileCoverage(snapshot, sloConfig) {
  const profile = sloConfig.profiles[snapshot.profile];
  if (profile === undefined) {
    throw new Error(`Public benchmark snapshot references unknown profile '${snapshot.profile}'.`);
  }
  const expectedScenarios = new Set(
    profile.tiers.flatMap((tier) => profile.scenarios.map((scenario) => `${tier}:${scenario}`)),
  );
  const actualScenarioKeys = snapshot.scenarios.map(
    (scenario) => `${scenario.tier}:${scenario.scenario}`,
  );
  assertExactKeyCoverage('scenario', actualScenarioKeys, expectedScenarios);

  const expectedTiers = new Set(profile.tiers);
  const actualTiers = snapshot.corpora.map((corpus) => corpus.tier);
  assertExactKeyCoverage('corpus tier', actualTiers, expectedTiers);

  const expectedBudgets = new Set(
    [...expectedScenarios].flatMap((key) =>
      ['exitCode', 'durationMs', 'maxRssBytes'].map((metric) => `${key}:${metric}`),
    ),
  );
  const actualBudgetKeys = snapshot.budgets.map(
    (row) => `${row.tier}:${row.scenario}:${row.metric}`,
  );
  assertExactKeyCoverage('budget', actualBudgetKeys, expectedBudgets);
}

function assertExactKeyCoverage(label, actualKeys, expectedKeys) {
  const actual = new Set(actualKeys);
  const missing = [...expectedKeys].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expectedKeys.has(key));
  const duplicateCount = actualKeys.length - actual.size;
  if (missing.length === 0 && extra.length === 0 && duplicateCount === 0) return;
  throw new Error(
    `Public benchmark snapshot ${label} coverage is incomplete ` +
      `(missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}; ` +
      `duplicates=${String(duplicateCount)}).`,
  );
}

export function formatBenchmarkDuration(ms) {
  if (ms === undefined) return 'not measured';
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }
  return `${String(ms)} ms`;
}

export function formatBenchmarkBytes(bytes) {
  if (bytes === undefined) return 'not measured';
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib % 1 === 0 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 / 1024;
  return `${mib % 1 === 0 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

export function formatBenchmarkInteger(value) {
  if (value === undefined) return '';
  return new Intl.NumberFormat('en-US').format(value);
}

function comparisonKey(tier, scenario, metric) {
  return `${tier}:${scenario}:${metric}`;
}

function budgetFromConfig(config, tier, scenario, metric) {
  const budget = config.budgetByKey.get(budgetKey(tier, scenario));
  if (budget === undefined) return;
  if (metric === 'durationMs') {
    return { budget: budget.maxDurationMs, status: 'budgeted' };
  }
  return { budget: budget.maxRssBytes, status: 'budgeted' };
}

function statusFromScenario(scenario, exitCodeStatus) {
  if (scenario.timedOut === true) return 'fail';
  if (scenario.status !== 0) return 'fail';
  if (exitCodeStatus === 'fail') return 'fail';
  return 'pass';
}

function margin(budget, actual) {
  if (budget === undefined || actual === undefined) return;
  return budget - actual;
}

function normalizeEnvironment(value) {
  if (!isRecord(value))
    throw new Error('Invalid benchmark snapshot: environment must be an object.');
  return {
    node: stringValue(value.node, 'environment.node'),
    pnpm: optionalString(value.pnpm),
    arch: optionalString(value.arch),
    platform: stringValue(value.platform, 'environment.platform'),
    release: stringValue(value.release, 'environment.release'),
    cpuModel: optionalString(value.cpuModel),
    cpuCount: positiveInteger(value.cpuCount, 'environment.cpuCount'),
    ci: typeof value.ci === 'boolean' ? value.ci : undefined,
    gitSha: optionalString(value.gitSha),
    gitBranch: optionalString(value.gitBranch),
    gitDirty: typeof value.gitDirty === 'boolean' ? value.gitDirty : undefined,
  };
}

function normalizeSnapshotConfig(value) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    throw new Error('Invalid benchmark snapshot: config must be an object.');
  }
  return {
    sourcePath: optionalString(value.sourcePath),
    fingerprint: optionalString(value.fingerprint),
    sampleIntervalMs: optionalPositiveInteger(value.sampleIntervalMs, 'config.sampleIntervalMs'),
  };
}

function normalizeCorpora(value) {
  if (!Array.isArray(value))
    throw new Error('Invalid benchmark snapshot: corpora must be an array.');
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Invalid benchmark snapshot: corpora[${index}] must be an object.`);
    const changedFiles = Array.isArray(entry.changedFiles)
      ? entry.changedFiles.map((file, fileIndex) =>
          stringValue(file, `corpora[${index}].changedFiles[${fileIndex}]`),
        )
      : undefined;
    const changedFileCount =
      changedFiles === undefined
        ? (optionalPositiveInteger(entry.changedFileCount, `corpora[${index}].changedFileCount`) ??
          0)
        : changedFiles.length;
    return {
      tier: stringValue(entry.tier, `corpora[${index}].tier`),
      fileCount: positiveInteger(entry.fileCount, `corpora[${index}].fileCount`),
      changedFiles,
      changedFileCount,
      gitReady: typeof entry.gitReady === 'boolean' ? entry.gitReady : false,
      contentSha256: optionalString(entry.contentSha256),
    };
  });
}

function normalizeScenarios(value) {
  if (!Array.isArray(value))
    throw new Error('Invalid benchmark snapshot: scenarios must be an array.');
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Invalid benchmark snapshot: scenarios[${index}] must be an object.`);
    return {
      tier: stringValue(entry.tier, `scenarios[${index}].tier`),
      scenario: stringValue(entry.scenario, `scenarios[${index}].scenario`),
      label: typeof entry.label === 'string' ? entry.label : '',
      status: optionalInteger(entry.status, `scenarios[${index}].status`),
      timedOut: typeof entry.timedOut === 'boolean' ? entry.timedOut : false,
      durationMs: optionalPositiveInteger(entry.durationMs, `scenarios[${index}].durationMs`),
      maxRssBytes: optionalPositiveInteger(entry.maxRssBytes, `scenarios[${index}].maxRssBytes`),
      graphProfile: normalizeGraphProfile(entry.graphProfile),
      skipped: typeof entry.skipped === 'boolean' ? entry.skipped : false,
      skipReason: typeof entry.skipReason === 'string' ? entry.skipReason : '',
    };
  });
}

function normalizeBudgetRows(value) {
  if (!Array.isArray(value))
    throw new Error('Invalid benchmark snapshot: budgets must be an array.');
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Invalid benchmark snapshot: budgets[${index}] must be an object.`);
    return {
      tier: stringValue(entry.tier, `budgets[${index}].tier`),
      scenario: stringValue(entry.scenario, `budgets[${index}].scenario`),
      metric: stringValue(entry.metric, `budgets[${index}].metric`),
      actual: optionalNumber(entry.actual, `budgets[${index}].actual`),
      budget: optionalNumber(entry.budget, `budgets[${index}].budget`),
      ratio: optionalNumber(entry.ratio, `budgets[${index}].ratio`),
      status: stringValue(entry.status, `budgets[${index}].status`),
      message: typeof entry.message === 'string' ? entry.message : '',
    };
  });
}

function normalizeGraphProfile(value) {
  if (value === undefined || value === null) return;
  if (!isRecord(value))
    throw new Error('Invalid benchmark snapshot: graphProfile must be an object.');
  return {
    mode: typeof value.mode === 'string' ? value.mode : undefined,
    cache: typeof value.cache === 'string' ? value.cache : undefined,
    files: optionalPositiveInteger(value.files, 'graphProfile.files'),
    functions: optionalPositiveInteger(value.functions, 'graphProfile.functions'),
  };
}

function stringValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid benchmark snapshot: ${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Invalid benchmark snapshot: ${name} must be a boolean.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid benchmark snapshot: ${name} must be a positive integer.`);
  }
  return value;
}

function optionalInteger(value, name) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value)) {
    throw new TypeError(`Invalid benchmark snapshot: ${name} must be an integer.`);
  }
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null) return;
  return positiveInteger(value, name);
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid benchmark snapshot: ${name} must be a finite number.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
