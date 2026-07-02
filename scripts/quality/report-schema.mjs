import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { relative, resolve } from 'node:path';

import { macroAverage } from './metrics.mjs';

export function createEmptyQualityReport(input) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    profile: input.profile,
    configHash: configHash(input.config),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpuCount: cpus().length,
      ci: process.env.CI === 'true',
    },
    config: {
      sourcePath: relative(input.repoRoot ?? process.cwd(), resolve(input.config.sourcePath)),
    },
    corpus: {
      caseCount: 0,
      decisionCount: 0,
      languages: {},
      checks: {},
    },
    results: [],
    metricsByCheck: {},
    macro: {
      precision: null,
      precisionChecks: 0,
      recall: null,
      recallChecks: 0,
      fpr: null,
      fprChecks: 0,
    },
    architectureUsefulness: {
      total: 0,
      contextChangesDecision: 0,
      contextDoesNotChangeDecision: 0,
      inconclusive: 0,
      decisionChangeRate: null,
      verdict: 'not-measured',
    },
    comparisons: [],
    verdict: 'pending',
  };
}

export function summarizeCorpus(cases) {
  const languages = {};
  const checks = {};
  let decisionCount = 0;
  for (const caseRecord of cases) {
    languages[caseRecord.language] = (languages[caseRecord.language] ?? 0) + 1;
    for (const expectation of caseRecord.checks) {
      decisionCount += 1;
      checks[expectation.slug] = (checks[expectation.slug] ?? 0) + 1;
    }
  }
  return { caseCount: cases.length, decisionCount, languages, checks };
}

export function finalizeQualityReport(report, results, architectureUsefulness, comparisons = []) {
  report.results = results;
  report.metricsByCheck = metricsByCheck(results);
  report.macro = macroAverage(Object.values(report.metricsByCheck));
  report.architectureUsefulness = architectureUsefulness ?? report.architectureUsefulness;
  report.comparisons = comparisons;
  report.verdict = comparisons.some((comparison) => comparison.status === 'fail') ? 'fail' : 'pass';
  return report;
}

export function baselineFromReport(report) {
  return {
    version: report.version,
    generatedAt: report.createdAt,
    profile: report.profile,
    configHash: report.configHash,
    corpus: report.corpus,
    metricsByCheck: report.metricsByCheck,
    macro: report.macro,
    architectureUsefulness: report.architectureUsefulness,
  };
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function configHash(config) {
  const normalized = {
    version: config.version,
    maxFixtureBytes: config.maxFixtureBytes,
    maxCases: config.maxCases,
    requiredLanguages: config.requiredLanguages,
    profiles: config.profiles,
    corpora: config.corpora,
    thresholds: config.thresholds,
    commandChecks: config.commandChecks,
    triage: config.triage,
    architectureUsefulness: config.architectureUsefulness,
  };
  return createHash('sha256').update(stableJson(normalized)).digest('hex');
}

function metricsByCheck(results) {
  const bySlug = new Map();
  for (const result of results) {
    const current = bySlug.get(result.slug) ?? {
      slug: result.slug,
      pack: result.pack,
      matrix: { tp: 0, fp: 0, fn: 0, tn: 0 },
      languages: {},
    };
    current.matrix[result.outcome] += 1;
    current.languages[result.language] = (current.languages[result.language] ?? 0) + 1;
    bySlug.set(result.slug, current);
  }
  return Object.fromEntries(
    [...bySlug.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, entry]) => [
        slug,
        {
          slug,
          pack: entry.pack,
          ...ratesFromMatrix(entry.matrix),
          languages: sortValue(entry.languages),
        },
      ]),
  );
}

function ratesFromMatrix(matrix) {
  const precisionDenominator = matrix.tp + matrix.fp;
  const recallDenominator = matrix.tp + matrix.fn;
  const fprDenominator = matrix.fp + matrix.tn;
  return {
    ...matrix,
    support: matrix.tp + matrix.fp + matrix.fn + matrix.tn,
    precision: precisionDenominator === 0 ? null : matrix.tp / precisionDenominator,
    recall: recallDenominator === 0 ? null : matrix.tp / recallDenominator,
    fpr: fprDenominator === 0 ? null : matrix.fp / fprDenominator,
  };
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
