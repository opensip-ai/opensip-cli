#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { compareBudgets } from './perf/compare-budgets.mjs';
import {
  BENCHMARK_NODE_OPTIONS,
  collectBenchmarkEnvironment,
  createCleanWallChildEnv,
} from './perf/benchmark-environment.mjs';
import {
  scenarioArgs,
  scenarioNeedsGraphCatalog,
  scenarioNeedsReportSession,
  scenarioRequiresGit,
  scenarioResetsRuntime,
} from './perf/benchmark-scenarios.mjs';
import { cleanupOwnedCorpus, materializeCorpus } from './perf/corpus.mjs';
import { isDirectInvocation } from './perf/direct-invocation.mjs';
import {
  createEmptyReport,
  createScenarioResult,
  finalizeReport,
  summarizeGraphProfile,
} from './perf/report-schema.mjs';
import { runMeasuredCommand } from './perf/run-command.mjs';
import { loadSloConfig } from './perf/slo-config.mjs';
import { signalsFromComparisons } from './perf/performance-signals.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_WORK_ROOT = resolve(REPO_ROOT, '.opensip-slo');
const DEFAULT_OUT = resolve(REPO_ROOT, 'slo-report.json');
const DEFAULT_TIMEOUT_MS = 300_000;

export async function runBenchSlo(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help === true) {
    return { exitCode: 0, report: null, comparisons: [], outPath: null };
  }
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const config = await (deps.loadSloConfig ?? loadSloConfig)(options.configPath);
  const profile = config.profiles[options.profile];
  if (profile === undefined) {
    throw new Error(
      `Unknown SLO profile '${options.profile}'. Available: ${Object.keys(config.profiles).join(', ')}`,
    );
  }

  const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
  if ((deps.existsSync ?? existsSync)(cliPath) !== true) {
    throw new Error('Built CLI not found. Run `pnpm build` before `pnpm bench:slo:ci`.');
  }

  const environment = await (deps.collectBenchmarkEnvironment ?? collectBenchmarkEnvironment)({
    repoRoot,
  });
  const report = createEmptyReport({
    profile: options.profile,
    quick: options.quick,
    config,
    repoRoot,
    measurementMode: 'clean-wall',
    environment,
  });
  const workRoot = resolve(repoRoot, options.workRoot ?? DEFAULT_WORK_ROOT, runId(options.profile));
  await (deps.mkdir ?? mkdir)(workRoot, { recursive: true });

  try {
    for (const tierId of profile.tiers) {
      const tier = config.tiers[tierId];
      const corpus = await (deps.materializeCorpus ?? materializeCorpus)({
        root: join(workRoot, tierId),
        tierId,
        tier,
        quick: options.quick,
      });
      report.corpora.push({
        tier: tierId,
        root: relative(repoRoot, corpus.root),
        fileCount: corpus.fileCount,
        changedFiles: corpus.changedFiles,
        gitReady: corpus.gitReady,
        contentSha256: corpus.contentSha256,
      });
      await runTierScenarios({
        repoRoot,
        cliPath,
        config,
        profile,
        tierId,
        corpus,
        report,
        options,
        deps,
      });
    }

    const comparisons = (deps.compareBudgets ?? compareBudgets)(report, config, {
      requireMemory: options.requireMemory,
    });
    const signals = (deps.signalsFromComparisons ?? signalsFromComparisons)(
      comparisons,
      options.profile,
    );
    finalizeReport(report, comparisons, signals);

    const outPath = resolve(repoRoot, options.out);
    await (deps.mkdir ?? mkdir)(dirname(outPath), { recursive: true });
    await (deps.writeFile ?? writeFile)(outPath, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report, comparisons, relative(repoRoot, outPath), deps);
    return {
      exitCode: report.verdict === 'fail' ? 1 : 0,
      report,
      comparisons,
      outPath,
    };
  } finally {
    if (!options.keepCorpus) {
      await (deps.rm ?? rm)(workRoot, { recursive: true, force: true }).catch(async () => {
        for (const tierId of profile.tiers) {
          await (deps.cleanupOwnedCorpus ?? cleanupOwnedCorpus)(join(workRoot, tierId)).catch(
            () => null,
          );
        }
      });
    }
  }
}

async function runTierScenarios(input) {
  const context = { graphPrimed: false };
  for (const scenario of input.profile.scenarios) {
    if (scenarioRequiresGit(scenario) && input.corpus.gitReady !== true) {
      input.report.scenarios.push(
        createScenarioResult({
          tier: input.tierId,
          scenario,
          label: input.config.scenarios[scenario]?.label ?? scenario,
          command: [],
          cwd: input.corpus.root,
          skipped: true,
          skipReason: 'git is unavailable for changed-file scenario',
        }),
      );
      continue;
    }
    await runOneScenario({ ...input, scenario, context });
  }
}

async function runOneScenario(input) {
  const graphProfilePath = join(input.corpus.root, `graph-profile-${input.scenario}.json`);
  if (scenarioResetsRuntime(input.scenario)) {
    await (input.deps.rm ?? rm)(join(input.corpus.root, 'opensip-cli', '.runtime'), {
      recursive: true,
      force: true,
    });
    input.context.graphPrimed = false;
  }
  if (scenarioNeedsGraphCatalog(input.scenario) && input.context.graphPrimed !== true) {
    const prime = await runCommand(input, ['graph', '--json', '--profile', graphProfilePath]);
    input.context.graphPrimed = prime.status === 0 && prime.timedOut !== true;
    if (input.context.graphPrimed !== true) {
      recordSetupFailure(input, prime, ['graph', '--json', '--profile', graphProfilePath]);
      return;
    }
  }

  if (scenarioNeedsReportSession(input.scenario)) {
    const prime = await runCommand(input, ['fit', '--json']);
    if (prime.status !== 0 || prime.timedOut === true) {
      recordSetupFailure(input, prime, ['fit', '--json']);
      return;
    }
  }

  const commandArgs = scenarioArgs(
    input.scenario,
    graphProfilePath,
    input.corpus.changedFiles[0] ?? 'src/module-0.ts',
  );
  const measured = await runCommand(input, commandArgs, input.scenario);
  if (input.scenario === 'graph-cold' || input.scenario === 'graph-warm') {
    input.context.graphPrimed = measured.status === 0;
  }
}

function recordSetupFailure(input, setup, args) {
  input.report.scenarios.push(
    createScenarioResult({
      tier: input.tierId,
      scenario: input.scenario,
      label: input.config.scenarios[input.scenario]?.label ?? input.scenario,
      command: [process.execPath, input.cliPath, '--no-cloud', ...args],
      cwd: input.corpus.root,
      startedAt: setup.startedAt,
      completedAt: setup.completedAt,
      status: setup.status,
      signal: setup.signal,
      timedOut: setup.timedOut,
      durationMs: setup.durationMs,
      maxRssBytes: setup.maxRssBytes,
      stdoutTail: setup.stdoutTail,
      stderrTail: setup.stderrTail,
      setupFailure: true,
    }),
  );
}

async function runCommand(input, commandArgs, scenario) {
  const command = [process.execPath, input.cliPath, '--no-cloud', ...commandArgs];
  const cleanEnvironment = createCleanWallChildEnv(process.env);
  const measured = await (input.deps.runMeasuredCommand ?? runMeasuredCommand)({
    command,
    cwd: input.corpus.root,
    env: {
      ...cleanEnvironment,
      NODE_OPTIONS: BENCHMARK_NODE_OPTIONS,
      OPENSIP_CLI_SKIP_INSTALLED: '1',
      OPENSIP_DISABLE_UPDATE_CHECK: '1',
    },
    timeoutMs: input.options.timeoutMs,
    sampleIntervalMs: input.config.sampleIntervalMs,
    stdoutTailBytes: input.config.tailBytes.stdout,
    stderrTailBytes: input.config.tailBytes.stderr,
  });

  if (scenario !== undefined) {
    input.report.scenarios.push(
      createScenarioResult({
        tier: input.tierId,
        scenario,
        label: input.config.scenarios[scenario]?.label ?? scenario,
        command,
        cwd: input.corpus.root,
        startedAt: measured.startedAt,
        completedAt: measured.completedAt,
        status: measured.status,
        signal: measured.signal,
        timedOut: measured.timedOut,
        durationMs: measured.durationMs,
        maxRssBytes: measured.maxRssBytes,
        stdoutTail: measured.stdoutTail,
        stderrTail: measured.stderrTail,
        graphProfile: await readGraphProfile(input.deps, input.corpus.root, commandArgs),
      }),
    );
  }
  return measured;
}

async function readGraphProfile(deps, cwd, commandArgs) {
  const profileIndex = commandArgs.indexOf('--profile');
  if (profileIndex === -1) return;
  const profilePath = commandArgs[profileIndex + 1];
  if (profilePath === undefined) return;
  try {
    const raw = await (deps.readFile ?? readFile)(resolve(cwd, profilePath), 'utf8');
    return summarizeGraphProfile(JSON.parse(raw));
  } catch {
    return;
  }
}

function parseArgs(argv) {
  const out = {
    profile: 'pr',
    quick: false,
    out: DEFAULT_OUT,
    configPath: '.config/performance-slos.json',
    workRoot: DEFAULT_WORK_ROOT,
    requireMemory: false,
    keepCorpus: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
      case '--quick': {
        out.quick = true;
        break;
      }
      case '--out': {
        out.out = requireValue(argv, ++index, arg);
        break;
      }
      case '--config': {
        out.configPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--work-root': {
        out.workRoot = requireValue(argv, ++index, arg);
        break;
      }
      case '--require-memory': {
        out.requireMemory = true;
        break;
      }
      case '--keep-corpus': {
        out.keepCorpus = true;
        break;
      }
      case '--timeout-ms': {
        out.timeoutMs = Number.parseInt(requireValue(argv, ++index, arg), 10);
        if (!Number.isInteger(out.timeoutMs) || out.timeoutMs <= 0) {
          throw new Error('--timeout-ms must be positive.');
        }
        break;
      }
      case '--help': {
        printHelp();
        return { ...out, help: true };
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

function runId(profile) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return `${profile}-${stamp}-${String(Math.round(performance.now()))}`;
}

function printSummary(report, comparisons, outPath, deps) {
  const log = deps.consoleLog ?? console.log;
  log(`Performance SLO verdict: ${report.verdict}`);
  log(`Report: ${outPath}`);
  for (const row of comparisons) {
    if (row.status === 'pass') continue;
    log(`${row.status.toUpperCase()} ${row.tier}/${row.scenario}/${row.metric}: ${row.message}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/bench-slo.mjs [options]

Options:
  --profile <name>      SLO profile from .config/performance-slos.json (default: pr)
  --quick               Use reduced corpus sizes for local smoke runs
  --out <path>          Report path (default: slo-report.json)
  --work-root <path>    Temporary corpus root (default: .opensip-slo)
  --require-memory      Treat missing process-tree RSS as a failed budget row
  --keep-corpus         Keep generated corpora for debugging
  --timeout-ms <ms>     Per-scenario timeout (default: ${String(DEFAULT_TIMEOUT_MS)})
`);
}

if (isDirectInvocation(import.meta.url)) {
  runBenchSlo().then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
