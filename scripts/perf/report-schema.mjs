import { cpus, platform, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');

export function createEmptyReport(input) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    profile: input.profile,
    quick: input.quick,
    repoRoot: input.repoRoot ?? REPO_ROOT,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpuCount: cpus().length,
      ci: process.env.CI === 'true',
    },
    config: {
      sourcePath: relative(input.repoRoot ?? REPO_ROOT, input.config.sourcePath),
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
  if (profile === undefined) return;
  const stages = Array.isArray(profile.stages)
    ? profile.stages.map((stage) => ({
        name: String(stage.name ?? stage.stage ?? 'unknown'),
        durationMs: numericOrUndefined(stage.durationMs ?? stage.ms),
      }))
    : [];
  return {
    mode: stringOrUndefined(profile.mode ?? profile.runMode),
    cache: stringOrUndefined(profile.cache ?? profile.cacheVerdict),
    files: numericOrUndefined(profile.files ?? profile.fileCount),
    functions: numericOrUndefined(profile.functions ?? profile.functionCount),
    stages,
  };
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
