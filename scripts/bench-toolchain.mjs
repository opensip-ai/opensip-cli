#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectBenchmarkEnvironment } from './perf/benchmark-environment.mjs';
import { runMeasuredCommand } from './perf/run-command.mjs';
import { createToolchainReport, renderToolchainMarkdown } from './perf/toolchain-report.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_REPETITIONS = 5;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REPETITIONS = 30;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const TAIL_BYTES = 16 * 1024;
const SAMPLE_INTERVAL_MS = 250;

const TOOLCHAIN_SCENARIOS = Object.freeze([
  Object.freeze({
    scenario: 'build',
    label: 'Workspace build',
    command: Object.freeze(['pnpm', 'build']),
  }),
  Object.freeze({
    scenario: 'typecheck',
    label: 'Workspace typecheck',
    command: Object.freeze(['pnpm', 'typecheck']),
  }),
  Object.freeze({
    scenario: 'type-aware-eslint',
    label: 'Type-aware ESLint',
    command: Object.freeze([
      'pnpm',
      'exec',
      'eslint',
      '--config',
      '.config/eslint.config.mjs',
      'packages/**/src/**/*.{ts,tsx}',
    ]),
  }),
]);

export async function runToolchainBenchmark(argv = process.argv.slice(2), deps = {}) {
  const options = parseToolchainArgs(argv);
  if (options.help === true) return { exitCode: 0, report: null };

  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const outPath = resolve(repoRoot, options.out);
  const markdownPath = resolve(repoRoot, options.markdownOut ?? defaultMarkdownPath(options.out));
  if (outPath === markdownPath) throw new Error('JSON and Markdown output paths must differ.');

  const [environment, typescript] = await Promise.all([
    (deps.collectBenchmarkEnvironment ?? collectBenchmarkEnvironment)({
      repoRoot,
    }),
    collectTypescriptMetadata(repoRoot, deps.readFile ?? readFile),
  ]);
  const childEnvironment = createChildEnvironment(deps.env ?? process.env, options.cacheMode);
  const samplesByScenario = new Map(TOOLCHAIN_SCENARIOS.map((scenario) => [scenario.scenario, []]));
  const stderr = deps.stderr ?? process.stderr;
  const runCommand = deps.runMeasuredCommand ?? runMeasuredCommand;

  for (let run = 1; run <= options.repetitions; run += 1) {
    for (const scenario of TOOLCHAIN_SCENARIOS) {
      stderr.write(
        `[toolchain ${String(run)}/${String(options.repetitions)}] ${scenario.command.join(' ')}\n`,
      );
      const measured = await runCommand({
        command: [...scenario.command],
        cwd: repoRoot,
        env: childEnvironment,
        timeoutMs: options.timeoutMs,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        stdoutTailBytes: TAIL_BYTES,
        stderrTailBytes: TAIL_BYTES,
      });
      assertSuccessfulMeasurement(measured, scenario, run);
      const scenarioSamples = samplesByScenario.get(scenario.scenario);
      if (scenarioSamples === undefined) {
        throw new Error(`Missing sample bucket for '${scenario.scenario}'.`);
      }
      scenarioSamples.push({
        run,
        status: measured.status,
        durationMs: measured.durationMs,
        maxRssBytes: measured.maxRssBytes,
        startedAt: measured.startedAt,
        completedAt: measured.completedAt,
      });
    }
  }

  const report = createToolchainReport({
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    repetitions: options.repetitions,
    cacheMode: options.cacheMode,
    environment,
    typescript,
    scenarios: TOOLCHAIN_SCENARIOS.map((scenario) => ({
      ...scenario,
      command: [...scenario.command],
      samples: samplesByScenario.get(scenario.scenario),
    })),
  });
  const markdown = renderToolchainMarkdown(report);
  await (deps.writeReports ?? writeReportsAtomic)({
    outPath,
    markdownPath,
    json: `${JSON.stringify(report, null, 2)}\n`,
    markdown,
  });
  (deps.stdout ?? process.stdout).write(
    `Toolchain benchmark: ${outPath}\nMarkdown summary: ${markdownPath}\n`,
  );
  return { exitCode: 0, report, outPath, markdownPath };
}

export function parseToolchainArgs(argv) {
  const options = {
    repetitions: DEFAULT_REPETITIONS,
    cacheMode: 'force',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--': {
        break;
      }
      case '--out': {
        options.out = requiredValue(argv, ++index, argument);
        break;
      }
      case '--markdown-out': {
        options.markdownOut = requiredValue(argv, ++index, argument);
        break;
      }
      case '--runs':
      case '--repetitions': {
        options.repetitions = boundedInteger(
          requiredValue(argv, ++index, argument),
          argument,
          1,
          MAX_REPETITIONS,
        );
        break;
      }
      case '--cache-mode': {
        options.cacheMode = requiredValue(argv, ++index, argument);
        if (!['force', 'reuse'].includes(options.cacheMode)) {
          throw new Error("--cache-mode must be 'force' or 'reuse'.");
        }
        break;
      }
      case '--timeout-ms': {
        options.timeoutMs = boundedInteger(
          requiredValue(argv, ++index, argument),
          argument,
          1000,
          MAX_TIMEOUT_MS,
        );
        break;
      }
      case '--help':
      case '-h': {
        return { ...options, help: true };
      }
      default: {
        throw new Error(`Unknown option ${String(argument)}.`);
      }
    }
  }
  if (options.out === undefined) throw new Error('--out is required.');
  return options;
}

function createChildEnvironment(source, cacheMode) {
  return {
    ...Object.fromEntries(Object.entries(source).filter((entry) => entry[1] !== undefined)),
    TURBO_FORCE: cacheMode === 'force' ? 'true' : 'false',
  };
}

async function collectTypescriptMetadata(repoRoot, read) {
  const [rootPackage, resolvedPackage] = await Promise.all([
    readJsonBestEffort(read, resolve(repoRoot, 'package.json')),
    readJsonBestEffort(read, resolve(repoRoot, 'node_modules/typescript/package.json')),
  ]);
  return {
    declared: optionalString(rootPackage?.devDependencies?.typescript),
    resolved: optionalString(resolvedPackage?.version),
  };
}

async function readJsonBestEffort(read, path) {
  try {
    const raw = await read(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return;
  }
}

function assertSuccessfulMeasurement(measured, scenario, run) {
  if (measured?.status === 0 && measured.timedOut !== true) {
    if (
      typeof measured.durationMs === 'number' &&
      Number.isFinite(measured.durationMs) &&
      measured.durationMs >= 0
    ) {
      return;
    }
    throw new Error(
      `Toolchain scenario '${scenario.scenario}' run ${String(run)} has no duration.`,
    );
  }
  const detail = boundedFailureDetail(measured?.stderrTail || measured?.stdoutTail);
  const timeout = measured?.timedOut === true ? ' (timed out)' : '';
  throw new Error(
    `Toolchain scenario '${scenario.scenario}' run ${String(run)} failed with status ${String(measured?.status ?? 'unknown')}${timeout}${detail}`,
  );
}

function boundedFailureDetail(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length === 0 ? '' : `: ${normalized.slice(-2000)}`;
}

async function writeReportsAtomic(input) {
  await Promise.all([
    writeAtomic(input.outPath, input.json),
    writeAtomic(input.markdownPath, input.markdown),
  ]);
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => null);
    throw error;
  }
}

function defaultMarkdownPath(jsonPath) {
  return extname(jsonPath).toLowerCase() === '.json'
    ? `${jsonPath.slice(0, -extname(jsonPath).length)}.md`
    : `${jsonPath}.md`;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function boundedInteger(raw, flag, minimum, maximum) {
  if (!/^\d+$/u.test(raw)) throw new Error(`${flag} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be between ${String(minimum)} and ${String(maximum)}.`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/bench-toolchain.mjs --out <report.json> [options]

Measure the fixed workspace build, typecheck, and type-aware ESLint commands.
This is developer/CI toolchain throughput evidence, not built CLI runtime evidence.

Options:
  --out <path>             JSON report path (required)
  --markdown-out <path>    Markdown report path (default: JSON path with .md)
  --runs <n>               Repetitions, 1-${String(MAX_REPETITIONS)} (default: ${String(DEFAULT_REPETITIONS)})
  --cache-mode <mode>      force (default) or reuse
  --timeout-ms <n>         Per-command timeout, 1000-${String(MAX_TIMEOUT_MS)}
  -h, --help               Show this help
`);
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isMainModule()) {
  runToolchainBenchmark()
    .then((result) => {
      if (result.report === null) printHelp();
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`);
      process.exitCode = 1;
    });
}
