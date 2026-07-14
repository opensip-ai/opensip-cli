#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { median } from './statistics.mjs';

const UNKNOWN = 'unknown';
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * Compare two SLO/profile reports without executing commands or reading runtime state.
 * Older reports are accepted: absent additive fields are represented as unknown.
 */
export function compareReports(baseReport, headReport, options = {}) {
  const base = normalizeBenchmarkReport(baseReport);
  const head = normalizeBenchmarkReport(headReport);
  const warnings = [];
  const incompatibilities = [];

  const baseMode = base.measurementMode;
  const headMode = head.measurementMode;
  if (baseMode !== UNKNOWN && headMode !== UNKNOWN && baseMode !== headMode) {
    const message =
      `Measurement mode mismatch (${baseMode} vs ${headMode}); ` +
      'wall-time and RSS deltas are not comparable.';
    if (options.allowModeMismatch !== true) throw new Error(message);
    incompatibilities.push(message);
  } else if (baseMode === UNKNOWN || headMode === UNKNOWN) {
    warnings.push(
      'At least one report predates measurementMode; treat wall-time claims as legacy evidence.',
    );
  }

  addContextMismatch(incompatibilities, 'Report kind', base.kind, head.kind);
  addContextMismatch(incompatibilities, 'Profile', base.profile, head.profile);
  addContextMismatch(incompatibilities, 'Quick/full posture', base.quick, head.quick);
  addContextMismatch(incompatibilities, 'OTLP export posture', base.otlpExport, head.otlpExport);
  addContextMismatch(
    incompatibilities,
    'Benchmark configuration',
    base.configFingerprint,
    head.configFingerprint,
  );
  addContextMismatch(
    incompatibilities,
    'Generated corpus',
    base.corporaFingerprint,
    head.corporaFingerprint,
  );
  addContextMismatch(incompatibilities, 'Cache posture', base.cacheMode, head.cacheMode);
  addContextMismatch(
    incompatibilities,
    'Toolchain protocol',
    base.protocolFingerprint,
    head.protocolFingerprint,
  );
  for (const [label, key] of [
    ['Architecture', 'arch'],
    ['Platform', 'platform'],
    ['OS release', 'release'],
    ['CPU model', 'cpuModel'],
    ['CPU count', 'cpuCount'],
    ['CI posture', 'ci'],
  ]) {
    addContextMismatch(incompatibilities, label, base.environment[key], head.environment[key]);
  }
  addAxisMismatch({
    incompatibilities,
    warnings,
    label: 'Node runtime',
    base: base.environment.node,
    head: head.environment.node,
    allowed: options.allowRuntimeMismatch === true,
  });
  for (const [label, key] of [
    ['pnpm runtime', 'pnpm'],
    ['TypeScript toolchain', 'typescript'],
  ]) {
    addAxisMismatch({
      incompatibilities,
      warnings,
      label,
      base: base.environment[key],
      head: head.environment[key],
      allowed: options.allowToolchainMismatch === true,
    });
  }
  const allowContextMismatch =
    options.allowContextMismatch === true || options.allowModeMismatch === true;
  if (incompatibilities.length > 0 && !allowContextMismatch) {
    throw new Error(
      `Benchmark context mismatch; performance deltas are not comparable: ${incompatibilities.join(' ')}`,
    );
  }
  warnings.push(...incompatibilities);
  const contextGaps = [
    ...missingContextWarnings(base, 'base'),
    ...missingContextWarnings(head, 'head'),
  ];
  warnings.push(...contextGaps);
  const contextComparable = incompatibilities.length === 0 && contextGaps.length === 0;

  const keys = [...new Set([...base.rows.keys(), ...head.rows.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const rows = keys.map((key) => {
    const baseRow = base.rows.get(key);
    const headRow = head.rows.get(key);
    const [tier = UNKNOWN, scenario = UNKNOWN] = key.split(':', 2);
    const rowWarnings = [];
    addFailedSampleWarning(rowWarnings, 'base', baseRow);
    addFailedSampleWarning(rowWarnings, 'head', headRow);
    const cacheMismatch = knownMismatch(baseRow?.cachePosture, headRow?.cachePosture);
    if (cacheMismatch) {
      rowWarnings.push(
        `Graph cache posture mismatch (${String(baseRow.cachePosture)} vs ${String(headRow.cachePosture)}); metrics are not compared.`,
      );
    }
    if (knownMismatch(baseRow?.sampleCount, headRow?.sampleCount)) {
      rowWarnings.push(
        `Sample-count mismatch (${String(baseRow.sampleCount)} vs ${String(headRow.sampleCount)}); metrics are not compared.`,
      );
    }
    const rowComparable = contextComparable && !cacheMismatch && rowWarnings.length === 0;
    return {
      tier,
      scenario,
      label: headRow?.label ?? baseRow?.label ?? scenario,
      sampleCount: {
        base: baseRow?.sampleCount,
        head: headRow?.sampleCount,
      },
      failedSamples: {
        base: baseRow?.failedSamples,
        head: headRow?.failedSamples,
      },
      comparable: rowComparable,
      durationMs: createDelta(baseRow?.durationMs, headRow?.durationMs, rowComparable),
      maxRssBytes: createDelta(baseRow?.maxRssBytes, headRow?.maxRssBytes, rowComparable),
      graphStages: compareGraphStages(baseRow?.graphStages, headRow?.graphStages, rowComparable),
      warnings: rowWarnings,
    };
  });

  return {
    version: 1,
    comparable: contextComparable && rows.every((row) => row.comparable),
    base: reportIdentity(base),
    head: reportIdentity(head),
    warnings,
    rows,
  };
}

export function normalizeBenchmarkReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('benchmark report must be an object');
  }
  let sourceRows = [];
  if (Array.isArray(report.scenarioSummaries)) {
    sourceRows = report.scenarioSummaries;
  } else if (Array.isArray(report.scenarios)) {
    sourceRows = report.scenarios;
  }
  const grouped = new Map();
  for (const sourceRow of sourceRows) {
    if (sourceRow === null || typeof sourceRow !== 'object' || sourceRow.skipped === true) continue;
    const tier = optionalString(sourceRow.tier) ?? UNKNOWN;
    const scenario = optionalString(sourceRow.scenario) ?? UNKNOWN;
    const key = `${tier}:${scenario}`;
    const group = grouped.get(key) ?? [];
    const samples = Array.isArray(sourceRow.samples) ? sourceRow.samples : [sourceRow];
    for (const sample of samples) group.push({ ...sample, aggregateSource: sourceRow });
    grouped.set(key, group);
  }

  const rows = new Map();
  for (const [key, samples] of grouped) {
    const successful = samples.filter((sample) => sampleSucceeded(sample));
    const aggregateSource = samples[0]?.aggregateSource;
    const declaredFailedSamples = nonNegativeInteger(aggregateSource?.failedSamples);
    const failedSamples = declaredFailedSamples ?? samples.length - successful.length;
    const durationMs =
      failedSamples > 0 ? undefined : aggregateMetric(aggregateSource, successful, 'durationMs');
    const maxRssBytes =
      failedSamples > 0 ? undefined : aggregateMetric(aggregateSource, successful, 'maxRssBytes');
    const graphStages = failedSamples > 0 ? new Map() : aggregateGraphStages(successful);
    const cachePosture = aggregateCachePosture(successful);
    rows.set(key, {
      label: optionalString(aggregateSource?.label),
      sampleCount: nonNegativeInteger(aggregateSource?.sampleCount) ?? samples.length,
      failedSamples,
      durationMs,
      maxRssBytes,
      graphStages,
      cachePosture,
    });
  }

  return {
    kind: inferReportKind(report),
    measurementMode: optionalString(report.measurementMode) ?? UNKNOWN,
    profile: optionalString(report.profile),
    quick: typeof report.quick === 'boolean' ? report.quick : undefined,
    otlpExport: normalizeOtlpPosture(report),
    configFingerprint: optionalString(report.config?.fingerprint),
    corporaFingerprint: fingerprintCorpora(report.corpora),
    cacheMode: optionalString(report.cache?.mode),
    protocolFingerprint: toolchainProtocolFingerprint(report),
    createdAt: optionalString(report.createdAt),
    environment: normalizeEnvironment(report.environment),
    rows,
  };
}

export function renderReportComparison(comparison) {
  const lines = [
    '# OpenSIP performance comparison',
    '',
    `- Base mode: ${comparison.base.measurementMode}`,
    `- Head mode: ${comparison.head.measurementMode}`,
    `- Base Node: ${comparison.base.environment.node ?? UNKNOWN}`,
    `- Head Node: ${comparison.head.environment.node ?? UNKNOWN}`,
  ];
  for (const warning of comparison.warnings) lines.push(`- Warning: ${warning}`);
  lines.push(
    '',
    '| Tier / scenario | Duration base | Duration head | Duration delta | RSS base | RSS head | RSS delta |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const row of comparison.rows) {
    lines.push(
      `| ${row.tier} / ${row.scenario} | ${formatDuration(row.durationMs.base)} | ` +
        `${formatDuration(row.durationMs.head)} | ${formatPercent(row.durationMs.percentChange)} | ` +
        `${formatBytes(row.maxRssBytes.base)} | ${formatBytes(row.maxRssBytes.head)} | ` +
        `${formatPercent(row.maxRssBytes.percentChange)} |`,
    );
    for (const warning of row.warnings) lines.push(`| ↳ warning | ${warning} |  |  |  |  |  |`);
  }

  const stageRows = comparison.rows.flatMap((row) =>
    row.graphStages.map((stage) => ({
      ...stage,
      tier: row.tier,
      scenario: row.scenario,
    })),
  );
  if (stageRows.length > 0) {
    lines.push(
      '',
      '## Graph stages',
      '',
      '| Tier / scenario | Stage | Base | Head | Delta |',
      '|---|---|---:|---:|---:|',
    );
    for (const row of stageRows) {
      lines.push(
        `| ${row.tier} / ${row.scenario} | ${row.name} | ${formatDuration(row.base)} | ` +
          `${formatDuration(row.head)} | ${formatPercent(row.percentChange)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parseCompareArgs(argv) {
  const options = {
    format: 'markdown',
    allowModeMismatch: false,
    allowContextMismatch: false,
    allowRuntimeMismatch: false,
    allowToolchainMismatch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--': {
        break;
      }
      case '--base': {
        options.base = requiredValue(argv, ++index, arg);
        break;
      }
      case '--head': {
        options.head = requiredValue(argv, ++index, arg);
        break;
      }
      case '--out': {
        options.out = requiredValue(argv, ++index, arg);
        break;
      }
      case '--format': {
        options.format = requiredValue(argv, ++index, arg);
        if (!['json', 'markdown'].includes(options.format)) {
          throw new Error('--format must be json or markdown.');
        }
        break;
      }
      case '--allow-mode-mismatch': {
        options.allowModeMismatch = true;
        options.allowContextMismatch = true;
        break;
      }
      case '--allow-context-mismatch': {
        options.allowContextMismatch = true;
        break;
      }
      case '--allow-runtime-mismatch': {
        options.allowRuntimeMismatch = true;
        break;
      }
      case '--allow-toolchain-mismatch': {
        options.allowToolchainMismatch = true;
        break;
      }
      case '--help': {
        return { ...options, help: true };
      }
      default: {
        throw new Error(`Unknown option ${arg}.`);
      }
    }
  }
  if (options.help !== true && (options.base === undefined || options.head === undefined)) {
    throw new Error('--base and --head are required.');
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCompareArgs(argv);
  if (options.help === true) {
    printHelp();
    return;
  }
  const [baseText, headText] = await Promise.all([
    readFile(options.base, 'utf8'),
    readFile(options.head, 'utf8'),
  ]);
  const comparison = compareReports(JSON.parse(baseText), JSON.parse(headText), options);
  const output =
    options.format === 'json'
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : renderReportComparison(comparison);
  if (options.out === undefined) {
    process.stdout.write(output);
  } else {
    await writeFile(options.out, output);
  }
}

function aggregateMetric(source, samples, metric) {
  const summaryValue =
    numericValue(source?.summary?.[metric]?.median) ??
    numericValue(source?.[metric]?.median) ??
    numericValue(source?.aggregates?.[metric]?.median);
  if (summaryValue !== undefined) return summaryValue;
  const values = samples
    .map((sample) => numericValue(sample[metric]))
    .filter((value) => isDefined(value));
  return values.length === 0 ? undefined : median(values);
}

function aggregateGraphStages(samples) {
  const valuesByName = new Map();
  for (const sample of samples) {
    const directStages = sample.graphProfile?.stages ?? sample.graphStages;
    const stages = Array.isArray(directStages)
      ? directStages
      : aggregateRunStages(sample.graphProfile?.runs);
    if (!Array.isArray(stages)) continue;
    for (const stage of stages) {
      const name = optionalString(stage?.name ?? stage?.stage);
      const durationMs =
        numericValue(stage?.durationMs?.median) ??
        numericValue(stage?.durationMs) ??
        numericValue(stage?.ms);
      if (name === undefined || durationMs === undefined) continue;
      const values = valuesByName.get(name) ?? [];
      values.push(durationMs);
      valuesByName.set(name, values);
    }
  }
  return new Map(
    [...valuesByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [name, median(values)]),
  );
}

function aggregateRunStages(runs) {
  if (!Array.isArray(runs)) return [];
  const totals = new Map();
  for (const run of runs) {
    if (!Array.isArray(run?.stages)) continue;
    for (const stage of run.stages) {
      const name = optionalString(stage?.name ?? stage?.stage);
      const durationMs = numericValue(stage?.durationMs ?? stage?.ms);
      if (name === undefined || durationMs === undefined) continue;
      totals.set(name, (totals.get(name) ?? 0) + durationMs);
    }
  }
  return [...totals.entries()].map(([name, durationMs]) => ({ name, durationMs }));
}

function compareGraphStages(baseStages = new Map(), headStages = new Map(), comparable = true) {
  const names = [...new Set([...baseStages.keys(), ...headStages.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  return names.map((name) => ({
    name,
    ...createDelta(baseStages.get(name), headStages.get(name), comparable),
  }));
}

function createDelta(base, head, comparable = true) {
  if (!comparable || base === undefined || head === undefined) {
    return { base, head, delta: undefined, percentChange: undefined };
  }
  const delta = head - base;
  let percentChange;
  if (base === 0) {
    if (head === 0) percentChange = 0;
  } else {
    percentChange = (delta / base) * 100;
  }
  return { base, head, delta, percentChange };
}

function sampleSucceeded(sample) {
  if (sample.skipped === true || sample.timedOut === true) return false;
  return sample.status === undefined || sample.status === 0;
}

function addFailedSampleWarning(warnings, side, row) {
  if ((row?.failedSamples ?? 0) > 0) {
    warnings.push(
      `${side} report has ${String(row.failedSamples)} failed sample(s); metrics are not compared.`,
    );
  }
}

function addContextMismatch(mismatches, label, base, head) {
  if (knownMismatch(base, head)) {
    mismatches.push(`${label} mismatch (${String(base)} vs ${String(head)}).`);
  }
}

function addAxisMismatch(input) {
  if (!knownMismatch(input.base, input.head)) return;
  const message = `${input.label} mismatch (${String(input.base)} vs ${String(input.head)}).`;
  if (input.allowed) {
    input.warnings.push(`${message} Explicit comparison-axis override enabled.`);
  } else {
    input.incompatibilities.push(message);
  }
}

function knownMismatch(base, head) {
  return base !== undefined && head !== undefined && base !== head;
}

function reportIdentity(report) {
  return {
    measurementMode: report.measurementMode,
    kind: report.kind,
    profile: report.profile,
    quick: report.quick,
    otlpExport: report.otlpExport,
    configFingerprint: report.configFingerprint,
    corporaFingerprint: report.corporaFingerprint,
    cacheMode: report.cacheMode,
    protocolFingerprint: report.protocolFingerprint,
    createdAt: report.createdAt,
    environment: report.environment,
  };
}

function normalizeEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    return {};
  }
  return {
    node: optionalString(environment.node),
    pnpm: optionalString(environment.pnpm),
    typescript: optionalString(environment.typescript),
    arch: optionalString(environment.arch),
    platform: optionalString(environment.platform),
    release: optionalString(environment.release),
    cpuModel: optionalString(environment.cpuModel),
    cpuCount: nonNegativeInteger(environment.cpuCount),
    ci: typeof environment.ci === 'boolean' ? environment.ci : undefined,
    gitSha: optionalString(environment.gitSha),
    gitBranch: optionalString(environment.gitBranch),
  };
}

function inferReportKind(report) {
  const explicit = optionalString(report.kind);
  if (explicit !== undefined) return explicit;
  if (report.measurementMode === 'toolchain-throughput' || report.profile === 'toolchain') {
    return 'opensip-toolchain-benchmark';
  }
}

function normalizeOtlpPosture(report) {
  if (typeof report.otlpExport === 'boolean') return report.otlpExport;
  if (report.kind === 'opensip-performance-slo' && report.measurementMode === 'clean-wall') {
    return false;
  }
}

function fingerprintCorpora(corpora) {
  if (!Array.isArray(corpora)) return;
  const normalized = corpora
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      tier: optionalString(entry.tier) ?? UNKNOWN,
      fileCount: nonNegativeInteger(entry.fileCount),
      changedFileCount: Array.isArray(entry.changedFiles)
        ? entry.changedFiles.length
        : nonNegativeInteger(entry.changedFileCount),
      gitReady: typeof entry.gitReady === 'boolean' ? entry.gitReady : undefined,
    }))
    .sort((left, right) => left.tier.localeCompare(right.tier));
  return normalized.length === 0 ? undefined : JSON.stringify(normalized);
}

function aggregateCachePosture(samples) {
  const values = new Set(
    samples
      .map((sample) => optionalString(sample.graphProfile?.cache))
      .filter((value) => value !== undefined),
  );
  if (values.size === 0) return;
  if (values.size > 1) return 'mixed';
  return values.values().next().value;
}

function toolchainProtocolFingerprint(report) {
  if (inferReportKind(report) !== 'opensip-toolchain-benchmark') return;
  if (
    !Number.isSafeInteger(report.repetitions) ||
    report.repetitions <= 0 ||
    !Array.isArray(report.iterationOrder) ||
    !Array.isArray(report.scenarios)
  ) {
    return;
  }
  const commands = report.scenarios.map((scenario) => ({
    scenario: optionalString(scenario?.scenario) ?? UNKNOWN,
    command: Array.isArray(scenario?.command) ? scenario.command.map(String) : undefined,
  }));
  if (commands.some((entry) => entry.command === undefined)) return;
  return JSON.stringify({
    repetitions: report.repetitions,
    iterationOrder: report.iterationOrder.map(String),
    commands,
  });
}

function missingContextWarnings(report, side) {
  const missing = [];
  const requireField = (label, value) => {
    if (value === undefined || value === UNKNOWN) missing.push(label);
  };
  requireField('report kind', report.kind);
  requireField('measurement mode', report.measurementMode);
  requireField('profile', report.profile);
  for (const [label, value] of [
    ['Node runtime', report.environment.node],
    ['architecture', report.environment.arch],
    ['platform', report.environment.platform],
    ['OS release', report.environment.release],
    ['CPU model', report.environment.cpuModel],
    ['CPU count', report.environment.cpuCount],
    ['CI posture', report.environment.ci],
  ]) {
    requireField(label, value);
  }
  if (report.kind === 'opensip-toolchain-benchmark') {
    requireField('cache posture', report.cacheMode);
    requireField('toolchain protocol', report.protocolFingerprint);
  } else {
    requireField('quick/full posture', report.quick);
    requireField('OTLP export posture', report.otlpExport);
    requireField('benchmark configuration fingerprint', report.configFingerprint);
    requireField('generated corpus fingerprint', report.corporaFingerprint);
  }
  return missing.length === 0
    ? []
    : [
        `${side} report lacks ${missing.join(', ')}; parse is supported, but performance deltas are suppressed.`,
      ];
}

function numericValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isDefined(value) {
  return value !== undefined;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function formatDuration(value) {
  if (value === undefined) return UNKNOWN;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (value === undefined) return UNKNOWN;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatPercent(value) {
  if (value === undefined) return UNKNOWN;
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(1)}%`;
}

function printHelp() {
  console.log(`Usage: node scripts/perf/compare-reports.mjs --base <report> --head <report> [options]

Options:
  --format <markdown|json>  Output format (default: markdown)
  --out <path>              Write output to a file instead of stdout
  --allow-mode-mismatch     Permit diagnostic-only clean/profile comparisons
  --allow-context-mismatch  Render diagnostic-only incompatible contexts without deltas
  --allow-runtime-mismatch  Compare an intentional Node runtime experiment
  --allow-toolchain-mismatch Compare an intentional pnpm/TypeScript experiment
`);
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
