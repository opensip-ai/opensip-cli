import { cpus, platform, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');

export function createEmptyReport(input) {
  return {
    version: 1,
    kind: 'opensip-performance-slo',
    createdAt: new Date().toISOString(),
    profile: input.profile,
    quick: input.quick,
    measurementMode: input.measurementMode,
    repoRoot: input.repoRoot ?? REPO_ROOT,
    environment: input.environment ?? defaultEnvironment(),
    config: {
      sourcePath: relative(input.repoRoot ?? REPO_ROOT, input.config.sourcePath),
      fingerprint: input.config.fingerprint,
      sampleIntervalMs: input.config.sampleIntervalMs,
      tailBytes: input.config.tailBytes,
    },
    corpora: [],
    scenarios: [],
    budgets: [],
    signals: [],
    verdict: 'pending',
  };
}

export function createScenarioResult(input) {
  return {
    tier: input.tier,
    scenario: input.scenario,
    label: input.label,
    command: input.command,
    cwd: input.cwd,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    signal: input.signal,
    timedOut: input.timedOut,
    durationMs: input.durationMs,
    maxRssBytes: input.maxRssBytes,
    stdoutTail: input.stdoutTail,
    stderrTail: input.stderrTail,
    graphProfile: input.graphProfile,
    skipped: input.skipped,
    skipReason: input.skipReason,
  };
}

export function finalizeReport(report, comparisons, signals) {
  const failed = comparisons.some((comparison) => comparison.status === 'fail');
  const warned = comparisons.some((comparison) => comparison.status === 'warn');
  report.budgets = comparisons;
  report.signals = signals;
  if (failed) {
    report.verdict = 'fail';
  } else if (warned) {
    report.verdict = 'warn';
  } else {
    report.verdict = 'pass';
  }
  return report;
}

export function summarizeGraphProfile(profile) {
  if (!isRecord(profile)) return;
  const runs = Array.isArray(profile.runs)
    ? profile.runs.filter((run) => isRecord(run)).map((run) => summarizeGraphProfileRun(run))
    : [];
  const primary = aggregateGraphProfileRuns(runs) ?? summarizeGraphProfileRun(profile);
  return {
    mode: stringOrUndefined(profile.mode ?? profile.runMode ?? primary.mode),
    resolutionMode: stringOrUndefined(profile.resolutionMode),
    durationMs: numericOrUndefined(profile.durationMs ?? primary.durationMs),
    cache: primary.cache,
    files: primary.files,
    functions: primary.functions,
    stages: primary.stages,
    ...(runs.length === 0 ? {} : { runs }),
  };
}

function aggregateGraphProfileRuns(runs) {
  if (runs.length === 0) return;
  const stages = new Map();
  for (const run of runs) {
    for (const stage of run.stages) {
      const current = stages.get(stage.name) ?? {
        name: stage.name,
        status: 'cached',
        durationMs: 0,
        measured: false,
      };
      if (stage.status !== 'cached') current.status = 'done';
      if (typeof stage.durationMs === 'number') {
        current.durationMs += stage.durationMs;
        current.measured = true;
      }
      stages.set(stage.name, current);
    }
  }
  const cacheValues = new Set(runs.map((run) => run.cache).filter((value) => value !== undefined));
  let cache;
  if (cacheValues.size === 1) cache = cacheValues.values().next().value;
  if (cacheValues.size > 1) cache = 'mixed';
  return {
    mode: uniqueValue(runs.map((run) => run.mode)),
    durationMs: sumDefined(runs.map((run) => run.durationMs)),
    cache,
    files: sumDefined(runs.map((run) => run.files)),
    functions: sumDefined(runs.map((run) => run.functions)),
    stages: [...stages.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ measured, ...stage }) => ({
        ...stage,
        ...(measured ? {} : { durationMs: undefined }),
      })),
  };
}

function sumDefined(values) {
  const measured = values.filter((value) => typeof value === 'number');
  return measured.length === 0 ? undefined : measured.reduce((sum, value) => sum + value, 0);
}

function uniqueValue(values) {
  const defined = new Set(values.filter((value) => value !== undefined));
  return defined.size === 1 ? defined.values().next().value : undefined;
}

function summarizeGraphProfileRun(run) {
  const summary = isRecord(run.summary) ? run.summary : {};
  return {
    label: stringOrUndefined(run.label),
    mode: stringOrUndefined(run.mode ?? run.runMode),
    durationMs: numericOrUndefined(run.durationMs),
    cache: cacheVerdict(summary.cacheHit ?? run.cache ?? run.cacheVerdict),
    files: numericOrUndefined(summary.files ?? run.files ?? run.fileCount),
    functions: numericOrUndefined(summary.functions ?? run.functions ?? run.functionCount),
    stages: summarizeGraphStages(run.stages),
  };
}

function summarizeGraphStages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((stage) => isRecord(stage))
    .map((stage) => ({
      name: String(stage.name ?? stage.stage ?? 'unknown'),
      status: stringOrUndefined(stage.status),
      durationMs: numericOrUndefined(stage.durationMs ?? stage.ms),
    }));
}

function cacheVerdict(value) {
  if (value === true) return 'hit';
  if (value === false) return 'miss';
  return stringOrUndefined(value);
}

function numericOrUndefined(value) {
  let result;
  if (typeof value === 'number' && Number.isFinite(value)) result = value;
  return result;
}

function stringOrUndefined(value) {
  let result;
  if (typeof value === 'string' && value.length > 0) result = value;
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultEnvironment() {
  const processors = cpus();
  return {
    node: process.version,
    pnpm: 'unavailable',
    arch: process.arch,
    platform: platform(),
    release: release(),
    cpuModel: stringOrUndefined(processors[0]?.model),
    cpuCount: processors.length,
    ci: process.env.CI === 'true',
  };
}
