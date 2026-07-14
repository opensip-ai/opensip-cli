#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
} from './perf/benchmark-scenarios.mjs';
import { cleanupOwnedCorpus, materializeCorpus } from './perf/corpus.mjs';
import {
  captureProfileArtifactSnapshot,
  hasProfileArtifactPair,
  indexNewProfileArtifacts,
} from './perf/profile-artifacts.mjs';
import {
  createProfileReport,
  finalizeProfileReport,
  renderProfileMarkdown,
} from './perf/profile-report.mjs';
import { summarizeGraphProfile } from './perf/report-schema.mjs';
import { runMeasuredCommand } from './perf/run-command.mjs';
import { loadSloConfig } from './perf/slo-config.mjs';
import { extractStartupDiagnostics } from './perf/startup-diagnostics.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_WORK_ROOT = resolve(REPO_ROOT, '.opensip-profile');
const DEFAULT_OUT = resolve(REPO_ROOT, 'profile-report.json');
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RUNS = 3;
const MAX_RUNS = 10;
const STDOUT_DOCUMENT_CAP_BYTES = 1024 * 1024;

export async function runBenchProfile(argv = process.argv.slice(2), deps = {}) {
  const options = parseProfileArgs(argv);
  if (options.help === true) return { exitCode: 0, report: null };
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const outPath = resolve(repoRoot, options.out);
  const markdownPath = resolve(repoRoot, options.markdown ?? defaultMarkdownPath(options.out));
  if (outPath === markdownPath) {
    throw new Error('JSON and Markdown profile report paths must differ.');
  }
  const config = await (deps.loadSloConfig ?? loadSloConfig)(options.configPath);
  const profile = config.profiles[options.profile];
  if (profile === undefined) {
    throw new Error(
      `Unknown performance profile '${options.profile}'. Available: ${Object.keys(config.profiles).join(', ')}`,
    );
  }
  const scenarios = selectedScenarios(options.scenarios, profile.scenarios, config.scenarios);
  const cliPath = resolve(repoRoot, 'packages/cli/dist/index.js');
  if ((deps.existsSync ?? existsSync)(cliPath) !== true) {
    throw new Error('Built CLI not found. Run `pnpm build` before `pnpm bench:profile`.');
  }

  const environment = await (deps.collectBenchmarkEnvironment ?? collectBenchmarkEnvironment)({
    repoRoot,
  });
  const measurementMode = options.cpuProfile ? 'cpu-profile' : 'clean-wall';
  const report = createProfileReport({
    measurementMode,
    otlpExport: options.otlpEndpoint !== undefined,
    profile: options.profile,
    quick: options.quick,
    runs: options.runs,
    repoRoot,
    environment,
    config,
  });
  const workRoot = resolve(repoRoot, options.workRoot, profileRunId(options.profile));
  await (deps.mkdir ?? mkdir)(workRoot, { recursive: true });

  try {
    for (const tierId of profile.tiers) {
      const corpus = await (deps.materializeCorpus ?? materializeCorpus)({
        root: join(workRoot, 'corpora', tierId),
        tierId,
        tier: config.tiers[tierId],
        quick: options.quick,
      });
      report.corpora.push({
        tier: tierId,
        root: relative(repoRoot, corpus.root),
        fileCount: corpus.fileCount,
        changedFiles: corpus.changedFiles,
        gitReady: corpus.gitReady,
      });
      for (const scenario of scenarios) {
        if (scenarioRequiresGit(scenario) && corpus.gitReady !== true) {
          report.scenarios.push(
            ...Array.from({ length: options.runs }, (_, index) => ({
              tier: tierId,
              scenario,
              label: config.scenarios[scenario]?.label ?? scenario,
              sample: index + 1,
              skipped: true,
              skipReason: 'git is unavailable for changed-file scenario',
            })),
          );
          continue;
        }
        for (let sample = 1; sample <= options.runs; sample += 1) {
          report.scenarios.push(
            await runProfileSample({
              repoRoot,
              cliPath,
              config,
              tierId,
              corpus,
              scenario,
              sample,
              workRoot,
              options,
              deps,
            }),
          );
        }
      }
    }
    finalizeProfileReport(report);
    await (deps.mkdir ?? mkdir)(dirname(outPath), { recursive: true });
    await (deps.mkdir ?? mkdir)(dirname(markdownPath), { recursive: true });
    const reports = {
      outPath,
      markdownPath,
      json: `${JSON.stringify(report, null, 2)}\n`,
      markdown: renderProfileMarkdown(report),
    };
    if (deps.writeFile === undefined) {
      await writeProfileReportsAtomic(reports);
    } else {
      await Promise.all([
        deps.writeFile(outPath, reports.json),
        deps.writeFile(markdownPath, reports.markdown),
      ]);
    }
    (deps.consoleLog ?? console.log)(`Performance profile verdict: ${report.verdict}`);
    (deps.consoleLog ?? console.log)(`JSON report: ${relative(repoRoot, outPath)}`);
    (deps.consoleLog ?? console.log)(`Markdown report: ${relative(repoRoot, markdownPath)}`);
    return {
      exitCode: report.verdict === 'pass' ? 0 : 1,
      report,
      outPath,
      markdownPath,
      workRoot,
    };
  } finally {
    if (!options.keepCorpus) {
      await cleanupProfileWorkRoot(workRoot, profile.tiers, deps);
    }
  }
}

export function parseProfileArgs(argv) {
  const options = {
    profile: 'pr',
    quick: true,
    runs: DEFAULT_RUNS,
    scenarios: [],
    out: DEFAULT_OUT,
    configPath: '.config/performance-slos.json',
    workRoot: DEFAULT_WORK_ROOT,
    keepCorpus: true,
    cpuProfile: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--': {
        break;
      }
      case '--profile': {
        options.profile = requiredValue(argv, ++index, arg);
        break;
      }
      case '--scenario': {
        options.scenarios.push(requiredValue(argv, ++index, arg));
        break;
      }
      case '--runs': {
        options.runs = boundedInteger(requiredValue(argv, ++index, arg), arg, 1, MAX_RUNS);
        break;
      }
      case '--quick': {
        options.quick = true;
        break;
      }
      case '--full': {
        options.quick = false;
        break;
      }
      case '--cpu-profile': {
        options.cpuProfile = true;
        break;
      }
      case '--otlp-endpoint': {
        options.otlpEndpoint = loopbackEndpoint(requiredValue(argv, ++index, arg));
        break;
      }
      case '--out': {
        options.out = requiredValue(argv, ++index, arg);
        break;
      }
      case '--markdown': {
        options.markdown = requiredValue(argv, ++index, arg);
        break;
      }
      case '--config': {
        options.configPath = requiredValue(argv, ++index, arg);
        break;
      }
      case '--work-root': {
        options.workRoot = requiredValue(argv, ++index, arg);
        break;
      }
      case '--cleanup': {
        options.keepCorpus = false;
        break;
      }
      case '--timeout-ms': {
        options.timeoutMs = boundedInteger(
          requiredValue(argv, ++index, arg),
          arg,
          1,
          MAX_TIMEOUT_MS,
        );
        break;
      }
      case '--help': {
        printHelp();
        return { ...options, help: true };
      }
      default: {
        throw new Error(`Unknown option ${arg}.`);
      }
    }
  }
  if (options.otlpEndpoint !== undefined && !options.cpuProfile) {
    throw new Error('--otlp-endpoint requires --cpu-profile so the run is clearly experimental.');
  }
  return options;
}

export function createProfileChildEnv(source, input) {
  const cleanEnvironment = createCleanWallChildEnv(source);
  const env = {
    ...cleanEnvironment,
    NODE_OPTIONS: BENCHMARK_NODE_OPTIONS,
    OPENSIP_DISABLE_UPDATE_CHECK: '1',
    OPENSIP_CLI_SKIP_INSTALLED: '1',
    OPENSIP_RUN_ID: input.runId,
  };
  if (input.cpuProfile === true) {
    env.OPENSIP_PROFILING = '1';
    env.OPENSIP_PROFILE_DIR = input.artifactDirectory;
  }
  if (input.otlpEndpoint !== undefined) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = input.otlpEndpoint;
  }
  return env;
}

async function runProfileSample(input) {
  const runtimeRoot = join(input.corpus.root, 'opensip-cli', '.runtime');
  await (input.deps.rm ?? rm)(runtimeRoot, { recursive: true, force: true });
  const token = `${input.tierId}-${input.scenario}-${String(input.sample)}`;
  const graphProfilePath = join(input.workRoot, 'graph', `${token}.json`);
  await (input.deps.mkdir ?? mkdir)(dirname(graphProfilePath), {
    recursive: true,
  });
  const setup = await prepareScenario(input, graphProfilePath);
  if (setup !== undefined && (setup.status !== 0 || setup.timedOut === true)) {
    return failedSetupSample(input, setup);
  }

  const commandArgs = scenarioArgs(
    input.scenario,
    graphProfilePath,
    input.corpus.changedFiles[0] ?? 'src/module-0.ts',
  );
  const command = [process.execPath, input.cliPath, '--no-cloud', ...commandArgs];
  const artifactDirectory = join(input.workRoot, 'cpu', token);
  if (input.options.cpuProfile) {
    await (input.deps.mkdir ?? mkdir)(artifactDirectory, {
      recursive: true,
      mode: 0o700,
    });
  }
  const before = input.options.cpuProfile
    ? await (input.deps.captureProfileArtifactSnapshot ?? captureProfileArtifactSnapshot)(
        artifactDirectory,
      )
    : undefined;
  const measured = await (input.deps.runMeasuredCommand ?? runMeasuredCommand)({
    command,
    cwd: input.corpus.root,
    env: createProfileChildEnv(process.env, {
      cpuProfile: input.options.cpuProfile,
      otlpEndpoint: input.options.otlpEndpoint,
      artifactDirectory,
      runId: `perf-${token}`,
    }),
    timeoutMs: input.options.timeoutMs,
    sampleIntervalMs: input.config.sampleIntervalMs,
    stdoutTailBytes: input.config.tailBytes.stdout,
    stderrTailBytes: input.config.tailBytes.stderr,
    stdoutCaptureBytes: STDOUT_DOCUMENT_CAP_BYTES,
  });
  const after = input.options.cpuProfile
    ? await (input.deps.captureProfileArtifactSnapshot ?? captureProfileArtifactSnapshot)(
        artifactDirectory,
      )
    : undefined;
  const artifacts =
    before === undefined || after === undefined
      ? undefined
      : indexNewProfileArtifacts(before, after);
  let profileArtifactExpectation = 'not-requested';
  if (input.options.cpuProfile === true) {
    profileArtifactExpectation =
      input.scenario === 'cli-help' ? 'not-applicable-root-bailout' : 'required';
  }
  const profileArtifactFailure =
    profileArtifactExpectation === 'required' && !hasProfileArtifactPair(artifacts);
  const commandSucceeded = measured.status === 0 && measured.timedOut !== true;
  return {
    tier: input.tierId,
    scenario: input.scenario,
    label: input.config.scenarios[input.scenario]?.label ?? input.scenario,
    sample: input.sample,
    command,
    cwd: input.corpus.root,
    startedAt: measured.startedAt,
    completedAt: measured.completedAt,
    status: measured.status,
    signal: measured.signal,
    timedOut: measured.timedOut,
    durationMs: measured.durationMs,
    maxRssBytes: measured.maxRssBytes,
    stdoutTail: commandSucceeded ? undefined : measured.stdoutTail,
    stderrTail: commandSucceeded ? undefined : measured.stderrTail,
    graphProfile: await readGraphProfile(input.deps, graphProfilePath),
    startupDiagnostics: extractStartupDiagnostics(measured.stdoutCapture, {
      truncated: measured.stdoutTruncated,
    }),
    artifacts,
    profileArtifactExpectation,
    profileArtifactFailure,
    ...(profileArtifactFailure
      ? { profileArtifactFailureReason: 'CPU profiler produced no complete artifact pair.' }
      : {}),
  };
}

async function prepareScenario(input, graphProfilePath) {
  let args;
  if (scenarioNeedsGraphCatalog(input.scenario)) {
    args = ['graph', '--json', '--profile', `${graphProfilePath}.prime`];
  } else if (scenarioNeedsReportSession(input.scenario)) {
    args = ['fit', '--json'];
  } else {
    return;
  }
  const command = [process.execPath, input.cliPath, '--no-cloud', ...args];
  return (input.deps.runMeasuredCommand ?? runMeasuredCommand)({
    command,
    cwd: input.corpus.root,
    env: createProfileChildEnv(process.env, {
      cpuProfile: false,
      artifactDirectory: '',
      runId: `perf-setup-${input.tierId}-${input.scenario}-${String(input.sample)}`,
    }),
    timeoutMs: input.options.timeoutMs,
    sampleIntervalMs: input.config.sampleIntervalMs,
    stdoutTailBytes: input.config.tailBytes.stdout,
    stderrTailBytes: input.config.tailBytes.stderr,
  });
}

function failedSetupSample(input, setup) {
  return {
    tier: input.tierId,
    scenario: input.scenario,
    label: input.config.scenarios[input.scenario]?.label ?? input.scenario,
    sample: input.sample,
    status: setup.status,
    signal: setup.signal,
    timedOut: setup.timedOut,
    setupFailure: true,
    stdoutTail: setup.stdoutTail,
    stderrTail: setup.stderrTail,
  };
}

async function readGraphProfile(deps, profilePath) {
  try {
    const text = await (deps.readFile ?? readFile)(profilePath, 'utf8');
    return summarizeGraphProfile(JSON.parse(text));
  } catch {
    return;
  }
}

async function cleanupProfileWorkRoot(workRoot, tiers, deps) {
  await (deps.rm ?? rm)(workRoot, { recursive: true, force: true }).catch(async () => {
    for (const tierId of tiers) {
      await (deps.cleanupOwnedCorpus ?? cleanupOwnedCorpus)(
        join(workRoot, 'corpora', tierId),
      ).catch(() => null);
    }
  });
}

function selectedScenarios(explicit, configured, definitions) {
  const scenarios = explicit.length === 0 ? configured : explicit;
  for (const scenario of scenarios) {
    if (definitions[scenario] === undefined) {
      throw new Error(`Unknown performance scenario '${scenario}'.`);
    }
  }
  return [...new Set(scenarios)];
}

function defaultMarkdownPath(out) {
  const extension = extname(out);
  return extension.length === 0 ? `${out}.md` : `${out.slice(0, -extension.length)}.md`;
}

function profileRunId(profile) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return `${profile}-${timestamp}-${String(process.pid)}-${String(Math.round(performance.now()))}-${randomUUID().slice(0, 8)}`;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function boundedInteger(raw, flag, minimum, maximum) {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return value;
}

async function writeProfileReportsAtomic(input) {
  await Promise.all([
    writeAtomic(input.outPath, input.json),
    writeAtomic(input.markdownPath, input.markdown),
  ]);
}

async function writeAtomic(path, content) {
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

function loopbackEndpoint(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('--otlp-endpoint must be a valid loopback HTTP URL.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error('--otlp-endpoint must use localhost, 127.0.0.1, or ::1.');
  }
  return parsed.toString();
}

function printHelp() {
  console.log(`Usage: node scripts/bench-profile.mjs [options]

Options:
  --profile <name>         Scenario profile (default: pr)
  --scenario <id>         Run one scenario; repeat to select more
  --runs <count>           Equivalent-state repeats, 1-${String(MAX_RUNS)} (default: ${String(DEFAULT_RUNS)})
  --quick | --full         Reduced or configured corpus size (default: quick)
  --cpu-profile            Enable local Node inspector profiles (experiment mode)
  --otlp-endpoint <url>    Optional loopback OTLP export; requires --cpu-profile
  --out <path>             JSON report path (default: profile-report.json)
  --markdown <path>        Markdown summary path (default: beside JSON)
  --work-root <path>       Retained corpora and artifact root
  --cleanup                Delete the generated corpus and profile artifacts
  --timeout-ms <ms>        Per-command timeout
`);
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isMainModule()) {
  runBenchProfile().then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
