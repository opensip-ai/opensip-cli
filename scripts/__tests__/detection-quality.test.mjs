import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDetectionQuality } from '../measure-detection-quality.mjs';
import { scoreArchitectureUsefulness } from '../quality/architecture-usefulness.mjs';
import { indexChecks } from '../quality/check-loader.mjs';
import { compareQualityBaseline } from '../quality/compare-baseline.mjs';
import { normalizeQualityConfig } from '../quality/config.mjs';
import { loadQualityCorpus } from '../quality/corpus.mjs';
import { classifyOutcome, macroAverage, ratesForMatrix } from '../quality/metrics.mjs';
import { baselineFromReport, stableJson } from '../quality/report-schema.mjs';
import { renderQualityMarkdown } from '../quality/render-quality-markdown.mjs';
import { buildQualityBySlug, qualityPriority } from '../catalog-suppressions.mjs';

const MEMORY_CONFIG_PATH = '<memory>/detection-quality.json';

test('normalizeQualityConfig validates profiles, corpora, thresholds, and languages', () => {
  const config = normalizeQualityConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  assert.deepEqual(config.requiredLanguages, ['typescript']);
  assert.throws(
    () =>
      normalizeQualityConfig({
        ...minimalRawConfig(),
        requiredLanguages: ['kotlin'],
      }),
    /unsupported language kotlin/,
  );
  assert.throws(
    () =>
      normalizeQualityConfig({
        ...minimalRawConfig(),
        thresholds: { ...minimalRawConfig().thresholds, minPrecision: 2 },
      }),
    /thresholds\.minPrecision must be a number between 0 and 1/,
  );
});

test('loadQualityCorpus validates seeded case manifests and rejects traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-quality-corpus-'));
  const manifest = join(root, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      id: 'test',
      cases: [
        {
          id: 'case-a',
          language: 'typescript',
          files: [{ path: 'src/a.ts', content: 'export const value = 1;\n' }],
          targetPaths: ['src/a.ts'],
          checks: [{ slug: 'test-check', expectFinding: false }],
        },
      ],
    }),
  );
  const config = normalizeQualityConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const checkIndex = indexChecks([{ pack: 'test', check: fakeCheck('test-check') }]);
  const cases = await loadQualityCorpus({ roots: [manifest], config, checkIndex });
  assert.equal(cases[0].id, 'case-a');
  assert.equal(cases[0].files[0].path, 'src/a.ts');

  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      id: 'test',
      cases: [
        {
          id: 'case-a',
          language: 'typescript',
          files: [{ path: '../escape.ts', content: 'x' }],
          checks: [{ slug: 'test-check', expectFinding: false }],
        },
      ],
    }),
  );
  await assert.rejects(
    () => loadQualityCorpus({ roots: [manifest], config, checkIndex }),
    /escapes the corpus root/,
  );
  await rm(root, { recursive: true, force: true });
});

test('metric helpers calculate confusion matrix rates without NaN', () => {
  assert.equal(classifyOutcome({ expected: true, actual: false }), 'fn');
  assert.deepEqual(ratesForMatrix({ tp: 1, fp: 1, fn: 1, tn: 1 }), {
    tp: 1,
    fp: 1,
    fn: 1,
    tn: 1,
    support: 4,
    precision: 0.5,
    recall: 0.5,
    fpr: 0.5,
  });
  assert.deepEqual(ratesForMatrix({ tp: 0, fp: 0, fn: 0, tn: 0 }).precision, null);
  assert.equal(macroAverage([{ precision: null }, { precision: 1 }]).precision, 1);
});

test('runDetectionQuality supports fake dependencies and writes reports', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-quality-runner-'));
  await mkdir(join(repoRoot, '.config'), { recursive: true });
  const config = normalizeQualityConfig(
    minimalRawConfig(),
    join(repoRoot, '.config/detection-quality.json'),
  );
  const checkIndex = indexChecks([{ pack: 'test-pack', check: fakeCheck('test-check') }]);
  let reportText = '';
  let markdownText = '';
  const result = await runDetectionQuality(
    ['--profile', 'pr', '--out', 'report.json', '--markdown-out', 'report.md'],
    {
      repoRoot,
      loadQualityConfig: async () => config,
      loadFirstPartyChecks: async () => checkIndex,
      loadQualityCorpus: async () => [
        {
          id: 'case-a',
          corpus: 'test',
          language: 'typescript',
          files: [{ path: 'src/a.ts', content: 'export const value = 1;\n' }],
          targetPaths: ['src/a.ts'],
          checks: [{ slug: 'test-check', expectFinding: true }],
        },
      ],
      runCheckOnFixture: async () => ({
        findings: [{ ruleId: 'fit:test-check', message: 'found', severity: 'warning' }],
        total: 1,
      }),
      writeFile: async (path, content) => {
        if (String(path).endsWith('.md')) markdownText = content;
        else reportText = content;
      },
      mkdir,
      consoleLog: () => null,
    },
  );
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(reportText);
  assert.equal(report.metricsByCheck['test-check'].precision, 1);
  assert.match(markdownText, /Per-check metrics/);
  await rm(repoRoot, { recursive: true, force: true });
});

test('baseline comparison detects recall regressions and stale config hashes', () => {
  const config = normalizeQualityConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const report = {
    profile: 'pr',
    configHash: 'new',
    corpus: { languages: { typescript: 1 } },
    metricsByCheck: {
      'test-check': { support: 1, precision: 1, recall: 0, fpr: 0 },
    },
    architectureUsefulness: { verdict: 'pass' },
  };
  const baseline = {
    version: 1,
    profile: 'pr',
    configHash: 'old',
    metricsByCheck: {
      'test-check': { support: 1, precision: 1, recall: 1, fpr: 0 },
    },
  };
  const comparisons = compareQualityBaseline(report, baseline, config);
  assert.ok(comparisons.some((row) => row.metric === 'configHash'));
  assert.ok(comparisons.some((row) => row.metric === 'recall'));
});

test('baseline comparison applies absolute thresholds to new measured checks', () => {
  const config = normalizeQualityConfig(
    {
      ...minimalRawConfig(),
      thresholds: {
        ...minimalRawConfig().thresholds,
        minPrecision: 0.8,
      },
    },
    MEMORY_CONFIG_PATH,
  );
  const comparisons = compareQualityBaseline(
    {
      profile: 'pr',
      configHash: 'same',
      corpus: { languages: { typescript: 1 } },
      metricsByCheck: {
        'new-check': { support: 1, precision: 0.5, recall: 1, fpr: 0 },
      },
      architectureUsefulness: { verdict: 'pass' },
    },
    {
      version: 1,
      profile: 'pr',
      configHash: 'same',
      metricsByCheck: {},
    },
    config,
  );
  assert.ok(comparisons.some((row) => row.slug === 'new-check' && row.metric === 'precision'));
});

test('architecture usefulness distinguishes decision-changing context', () => {
  const result = scoreArchitectureUsefulness(
    [
      {
        id: 'a',
        label: 'a',
        rawDecision: 'warn',
        contextDecision: 'block',
        expected: 'context_changes_decision',
        rationale: 'test',
      },
      {
        id: 'b',
        label: 'b',
        rawDecision: 'warn',
        contextDecision: 'warn',
        expected: 'context_does_not_change_decision',
        rationale: 'test',
      },
    ],
    {
      minArchitectureScenarios: 2,
      minArchitectureDecisionChangeRate: 0.5,
    },
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.contextChangesDecision, 1);
});

test('catalog suppression helpers consume detection-quality baselines', () => {
  const quality = buildQualityBySlug({
    version: 1,
    metricsByCheck: {
      'test-check': {
        precision: 0.5,
        recall: 0.25,
        fpr: 0.5,
        support: 4,
        languages: { typescript: 4 },
      },
    },
  });
  const priority = qualityPriority('test-check', 2, { qualityBySlug: quality });
  assert.equal(priority.support, 4);
  assert.ok(priority.score > 0);
});

test('baselineFromReport and renderQualityMarkdown omit fixture source contents', () => {
  const report = {
    version: 1,
    createdAt: '2026-07-02T00:00:00.000Z',
    profile: 'pr',
    configHash: 'abc',
    corpus: { caseCount: 1, decisionCount: 1, languages: { typescript: 1 }, checks: {} },
    metricsByCheck: {
      'test-check': {
        slug: 'test-check',
        support: 1,
        tp: 1,
        fp: 0,
        fn: 0,
        tn: 0,
        precision: 1,
        recall: 1,
        fpr: 0,
        languages: { typescript: 1 },
      },
    },
    macro: { precision: 1, precisionChecks: 1, recall: 1, recallChecks: 1, fpr: 0, fprChecks: 1 },
    architectureUsefulness: {
      total: 0,
      contextChangesDecision: 0,
      contextDoesNotChangeDecision: 0,
      inconclusive: 0,
      decisionChangeRate: null,
      verdict: 'not-measured',
    },
    verdict: 'pass',
  };
  assert.equal(baselineFromReport(report).profile, 'pr');
  const markdown = renderQualityMarkdown(report);
  assert.doesNotMatch(markdown, /export const value/);
  assert.match(stableJson(report), /"profile": "pr"/);
});

test('committed generated Markdown exists after baseline update', () => {
  const path = join(process.cwd(), '.config/detection-quality-report.md');
  if (existsSync(path)) assert.match(readFileSync(path, 'utf8'), /Detection quality report/);
});

function minimalRawConfig() {
  return {
    version: 1,
    maxFixtureBytes: 1024,
    maxCases: 8,
    concurrency: 1,
    requiredLanguages: ['typescript'],
    profiles: {
      pr: { description: 'test', corpora: ['seeded'], architectureUsefulness: true },
    },
    corpora: {
      seeded: { manifest: 'manifest.json' },
    },
    thresholds: {
      minPrecision: 0,
      minRecall: 0,
      maxFpr: 1,
      precisionDropTolerance: 0,
      recallDropTolerance: 0,
      fprIncreaseTolerance: 0,
      supportDropTolerance: 0,
      minArchitectureScenarios: 0,
      minArchitectureDecisionChangeRate: 0,
    },
    commandChecks: { allow: {} },
    triage: {
      maxQualityRows: 10,
      suppressionMultiplier: 0.1,
      fprWeight: 2,
      recallGapWeight: 2,
      precisionGapWeight: 1,
    },
    architectureUsefulness: {
      scenarios: [],
    },
  };
}

function fakeCheck(slug) {
  return {
    config: {
      slug,
      analysisMode: 'analyze',
      disabled: false,
    },
  };
}
