#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreArchitectureUsefulness } from './quality/architecture-usefulness.mjs';
import { loadFirstPartyChecks } from './quality/check-loader.mjs';
import { compareQualityBaseline } from './quality/compare-baseline.mjs';
import { loadQualityConfig } from './quality/config.mjs';
import { loadQualityCorpus } from './quality/corpus.mjs';
import {
  baselineFromReport,
  createEmptyQualityReport,
  finalizeQualityReport,
  stableJson,
  summarizeCorpus,
} from './quality/report-schema.mjs';
import { renderQualityMarkdown, markdownFingerprint } from './quality/render-quality-markdown.mjs';
import { runCheckCase } from './quality/run-check-case.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_CONFIG = '.config/detection-quality.json';
const DEFAULT_BASELINE = '.config/detection-quality-baseline.json';
const DEFAULT_REPORT = 'detection-quality-report.json';
const DEFAULT_MARKDOWN_REPORT = '.config/detection-quality-report.md';

export async function runDetectionQuality(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help === true) return { exitCode: 0, report: null, comparisons: [], outPath: null };

  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const config = await (deps.loadQualityConfig ?? loadQualityConfig)(options.configPath);
  const profile = config.profiles[options.profile];
  if (profile === undefined) {
    throw new Error(
      `Unknown quality profile '${options.profile}'. Available: ${Object.keys(config.profiles).join(', ')}`,
    );
  }

  const checkIndex = await (deps.loadFirstPartyChecks ?? loadFirstPartyChecks)(
    deps.checkLoaderOptions ?? {},
  );
  const manifestPaths = [
    ...profile.corpora.map((corpusId) => config.corpora[corpusId].manifest),
    ...options.corpusRoots,
  ].map((path) => resolve(repoRoot, path));
  const cases = await (deps.loadQualityCorpus ?? loadQualityCorpus)({
    roots: manifestPaths,
    config,
    checkIndex,
  });

  const report = createEmptyQualityReport({ profile: options.profile, config, repoRoot });
  report.corpus = summarizeCorpus(cases);

  const runCheckOnFixture = await resolveFixtureRunner(deps);
  const results = [];
  for (const caseRecord of cases) {
    for (const expectation of caseRecord.checks) {
      const checkEntry = checkIndex.bySlug.get(expectation.slug);
      if (!checkEntry) {
        throw new Error(
          `Quality case ${caseRecord.id} references unknown check ${expectation.slug}.`,
        );
      }
      if (
        checkEntry.check.config.analysisMode === 'command' &&
        !(expectation.slug in config.commandChecks.allow)
      ) {
        results.push(
          skippedResult(
            caseRecord,
            expectation,
            checkEntry,
            'command-mode check not enabled for deterministic quality lane',
          ),
        );
        continue;
      }
      results.push(
        await (deps.runCheckCase ?? runCheckCase)({
          caseRecord,
          expectation,
          checkEntry,
          runCheckOnFixture,
        }),
      );
    }
  }

  const architectureUsefulness = profile.architectureUsefulness
    ? scoreArchitectureUsefulness(config.architectureUsefulness.scenarios, config.thresholds)
    : undefined;

  finalizeQualityReport(report, results, architectureUsefulness, []);
  const baseline = options.check ? await loadBaseline(options.baselinePath, deps) : null;
  const comparisons =
    baseline === null
      ? []
      : (deps.compareQualityBaseline ?? compareQualityBaseline)(report, baseline, config);
  finalizeQualityReport(report, results, architectureUsefulness, comparisons);

  const outPath = resolve(repoRoot, options.out);
  await (deps.mkdir ?? mkdir)(dirname(outPath), { recursive: true });
  await (deps.writeFile ?? writeFile)(outPath, stableJson(report));

  const markdown = renderQualityMarkdown(report);
  if (options.updateBaseline) {
    const baselinePath = resolve(repoRoot, options.baselinePath);
    const markdownPath = resolve(repoRoot, DEFAULT_MARKDOWN_REPORT);
    await (deps.mkdir ?? mkdir)(dirname(baselinePath), { recursive: true });
    await (deps.writeFile ?? writeFile)(baselinePath, stableJson(baselineFromReport(report)));
    await (deps.writeFile ?? writeFile)(markdownPath, markdown);
  } else if (options.markdownOut) {
    const markdownPath = resolve(repoRoot, options.markdownOut);
    await (deps.mkdir ?? mkdir)(dirname(markdownPath), { recursive: true });
    await (deps.writeFile ?? writeFile)(markdownPath, markdown);
  }

  if (options.check) {
    await assertMarkdownFresh(markdown, resolve(repoRoot, DEFAULT_MARKDOWN_REPORT), deps);
  }

  printSummary(report, relative(repoRoot, outPath), deps);
  return {
    exitCode: options.check && report.verdict === 'fail' ? 1 : 0,
    report,
    comparisons,
    outPath,
  };
}

async function resolveFixtureRunner(deps) {
  if (deps.runCheckOnFixture) return deps.runCheckOnFixture;
  try {
    const module = await import(
      `file://${resolve(REPO_ROOT, 'packages/test-support/dist/index.js')}`
    );
    return module.runCheckOnFixture;
  } catch (error) {
    throw new Error(
      `Could not load packages/test-support/dist/index.js. Run \`pnpm build\` or \`node scripts/build-ci.mjs\` first. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function loadBaseline(path, deps) {
  const baselinePath = resolve(deps.repoRoot ?? REPO_ROOT, path);
  const raw = await (deps.readFile ?? readFile)(baselinePath, 'utf8');
  return JSON.parse(raw);
}

async function assertMarkdownFresh(markdown, markdownPath, deps) {
  if (!(deps.existsSync ?? existsSync)(markdownPath)) {
    throw new Error(
      `Missing detection quality Markdown report ${markdownPath}. Run pnpm quality:measure:update.`,
    );
  }
  const current = await (deps.readFile ?? readFile)(markdownPath, 'utf8');
  if (markdownFingerprint(current) !== markdownFingerprint(markdown)) {
    throw new Error('Detection quality Markdown report is stale. Run pnpm quality:measure:update.');
  }
}

function skippedResult(caseRecord, expectation, checkEntry, reason) {
  return {
    caseId: caseRecord.id,
    corpus: caseRecord.corpus,
    language: caseRecord.language,
    slug: expectation.slug,
    pack: checkEntry.pack,
    expected: expectation.expectFinding,
    actual: false,
    outcome: expectation.expectFinding ? 'fn' : 'tn',
    findingCount: 0,
    findings: [],
    skipped: true,
    skipReason: reason,
  };
}

function parseArgs(argv) {
  const out = {
    profile: 'pr',
    configPath: DEFAULT_CONFIG,
    baselinePath: DEFAULT_BASELINE,
    out: DEFAULT_REPORT,
    markdownOut: null,
    corpusRoots: [],
    check: false,
    updateBaseline: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--': {
        break;
      }
      case '--profile': {
        out.profile = requireValue(argv, ++index, arg);
        break;
      }
      case '--config': {
        out.configPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--baseline': {
        out.baselinePath = requireValue(argv, ++index, arg);
        break;
      }
      case '--out': {
        out.out = requireValue(argv, ++index, arg);
        break;
      }
      case '--markdown-out': {
        out.markdownOut = requireValue(argv, ++index, arg);
        break;
      }
      case '--corpus-root': {
        out.corpusRoots.push(requireValue(argv, ++index, arg));
        break;
      }
      case '--check': {
        out.check = true;
        break;
      }
      case '--update-baseline': {
        out.updateBaseline = true;
        break;
      }
      case '--help': {
        printHelp();
        out.help = true;
        break;
      }
      default: {
        throw new Error(`Unknown option ${arg}.`);
      }
    }
  }
  return out;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function printSummary(report, outPath, deps) {
  const log = deps.consoleLog ?? console.log;
  log(`Detection quality verdict: ${report.verdict}`);
  log(`Report: ${outPath}`);
  log(
    `Cases: ${String(report.corpus.caseCount)}; decisions: ${String(report.corpus.decisionCount)}`,
  );
  log(
    `Macro precision ${formatRate(report.macro.precision)} / recall ${formatRate(report.macro.recall)} / FPR ${formatRate(report.macro.fpr)}`,
  );
  for (const comparison of report.comparisons) {
    if (comparison.status === 'pass') continue;
    log(
      `${comparison.status.toUpperCase()} ${comparison.slug}/${comparison.metric}: ${comparison.message}`,
    );
  }
}

function formatRate(value) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(3);
}

function printHelp() {
  console.log(`Usage: node scripts/measure-detection-quality.mjs [options]

Options:
  --profile <name>       Profile from .config/detection-quality.json (default: pr)
  --config <path>        Config path (default: .config/detection-quality.json)
  --baseline <path>      Baseline path (default: .config/detection-quality-baseline.json)
  --out <path>           JSON report path (default: detection-quality-report.json)
  --markdown-out <path>  Optional Markdown report path
  --corpus-root <path>   Extra local corpus manifest path; repeatable
  --check                Compare against the committed baseline and generated Markdown
  --update-baseline      Refresh .config baseline and Markdown report
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDetectionQuality().then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
