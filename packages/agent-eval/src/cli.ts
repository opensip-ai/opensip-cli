import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InvocationError,
  USAGE,
  knownTaskIds,
  parseArgs,
  selectTasks,
  selectedArms,
} from './cli-arguments.js';
import {
  CliHarnessError,
  NODE_ARTIFACT_FILE_SYSTEM,
  defaultJsonPath,
  outputPaths,
  persistReport,
  requireExplicitPairAvailable,
} from './cli-artifacts.js';
import { contractFingerprint } from './report/contract-fingerprint.js';
import { EVAL_REPORT_SCHEMA_VERSION } from './report/model.js';
import { resolveGitProvenance } from './runner/git-provenance.js';
import { runTaskArm } from './runner/run-task.js';
import {
  HarnessPrerequisiteError,
  resolveCliDist,
  spawnCli,
  tailForDiagnostics,
} from './runner/spawn.js';
import { taskRegistry } from './tasks/index.js';

import { AGENT_EVAL_VERSION } from './index.js';

import type { ParsedCliOptions } from './cli-arguments.js';
import type { ArtifactFileSystem, ArtifactPaths } from './cli-artifacts.js';
import type { Arm, GoldTask } from './model/task.js';
import type { EvalArmResult, EvalReport, EvalTaskResult, SourceState } from './report/model.js';
import type { GitProvenance } from './runner/git-provenance.js';
import type { EvaluatedArmRun } from './runner/run-task.js';

export { InvocationError, USAGE, parseArgs } from './cli-arguments.js';
export type { ParsedCliOptions } from './cli-arguments.js';
export { defaultJsonPath, markdownPathFor } from './cli-artifacts.js';
export type { ArtifactFileSystem, ArtifactPaths } from './cli-artifacts.js';
export { parseGitProvenance, resolveGitProvenance } from './runner/git-provenance.js';
export type { GitProvenance } from './runner/git-provenance.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RESULTS_ROOT = join(PACKAGE_ROOT, 'results');
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const VERSION_OUTPUT_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 30_000;

export interface CliDependencies {
  readonly artifactFileSystem: ArtifactFileSystem;
  readonly cwd: () => string;
  readonly harnessVersion: string;
  readonly nodeVersion: string;
  readonly now: () => Date;
  readonly platform: string;
  readonly registry: Readonly<Record<string, GoldTask>>;
  readonly resolveContractFingerprint: (tasks: readonly GoldTask[]) => Promise<string>;
  readonly resolveCliVersion: () => Promise<string>;
  readonly resolveGitProvenance: () => Promise<GitProvenance>;
  readonly resultsRoot: string;
  readonly runArm: (task: GoldTask, arm: Arm) => Promise<EvaluatedArmRun>;
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

/**
 * Resolve the built CLI's version through the harness's bounded CLI spawn seam.
 *
 * @throws {HarnessPrerequisiteError} When the built CLI or a valid version is unavailable.
 */
export async function resolveOpenSipCliVersion(): Promise<string> {
  void resolveCliDist();
  const result = await spawnCli(['--version'], {
    maxOutputBytes: VERSION_OUTPUT_BYTES,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const version = result.stdout.trim();
  if (
    result.error !== undefined ||
    result.exitCode !== 0 ||
    result.outputLimitExceeded ||
    result.timedOut ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new HarnessPrerequisiteError(
      'OpenSIP CLI version is unavailable; run pnpm build and retry agent-eval.',
    );
  }
  return version;
}

function classifySourceState(initial: GitProvenance, final: GitProvenance): SourceState {
  if (initial.gitSha !== final.gitSha) return 'changed-during-run';
  if (initial.worktreeDirty || final.worktreeDirty) return 'dirty';
  return 'clean';
}

export const DEFAULT_CLI_DEPENDENCIES: CliDependencies = Object.freeze({
  artifactFileSystem: NODE_ARTIFACT_FILE_SYSTEM,
  cwd: () => process.cwd(),
  harnessVersion: AGENT_EVAL_VERSION,
  nodeVersion: process.version,
  now: () => new Date(),
  platform: `${process.platform}-${process.arch}`,
  registry: taskRegistry,
  resolveContractFingerprint: contractFingerprint,
  resolveCliVersion: resolveOpenSipCliVersion,
  resolveGitProvenance,
  resultsRoot: DEFAULT_RESULTS_ROOT,
  runArm: (task: GoldTask, arm: Arm) => runTaskArm(task, arm),
  stderr: (text: string) => process.stderr.write(text),
  stdout: (text: string) => process.stdout.write(text),
});

function buildRequestedPaths(
  options: ParsedCliOptions,
  dependencies: CliDependencies,
): ArtifactPaths | undefined {
  return options.jsonPath === undefined
    ? undefined
    : outputPaths(resolve(dependencies.cwd(), options.jsonPath));
}

async function executeTasks(
  tasks: readonly GoldTask[],
  arms: readonly Arm[],
  dependencies: CliDependencies,
): Promise<readonly EvalTaskResult[]> {
  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    const armResults: Partial<Record<Arm, EvalArmResult>> = {};
    for (const arm of arms) {
      void dependencies.stderr(`agent-eval: ${task.id} [${arm}] starting\n`);
      armResults[arm] = await dependencies.runArm(task, arm);
      void dependencies.stderr(`agent-eval: ${task.id} [${arm}] complete\n`);
    }
    results.push({
      arms: armResults,
      completedAt: dependencies.now().toISOString(),
      taskId: task.id,
    });
  }
  return results;
}

function failedArmCount(report: EvalReport): number {
  return report.tasks.reduce(
    (total, task) =>
      total +
      report.selectedArms.filter((arm) => task.arms[arm]?.assertions.passed === false).length,
    0,
  );
}

function printSuccess(
  paths: ArtifactPaths,
  report: EvalReport,
  dependencies: CliDependencies,
): void {
  const armRuns = report.tasks.length * report.selectedArms.length;
  void dependencies.stdout(`Report: ${paths.jsonPath}\n`);
  void dependencies.stdout(
    `Completed ${String(report.tasks.length)} task(s), ${String(armRuns)} arm run(s), ${String(failedArmCount(report))} assertion failure(s).\n`,
  );
}

async function runEvaluation(
  tasks: readonly GoldTask[],
  arms: readonly Arm[],
  requestedPaths: ArtifactPaths | undefined,
  dependencies: CliDependencies,
): Promise<number> {
  const startedAtDate = dependencies.now();
  const startedAt = startedAtDate.toISOString();
  const [cliVersion, initialSource] = await Promise.all([
    dependencies.resolveCliVersion(),
    dependencies.resolveGitProvenance(),
  ]);
  const fingerprint = await dependencies.resolveContractFingerprint(tasks);
  if (initialSource.worktreeDirty) {
    void dependencies.stderr(
      'agent-eval: source worktree is dirty; report will be non-promotable\n',
    );
  }
  void dependencies.stderr(
    `agent-eval: running ${String(tasks.length)} task(s) across ${arms.join(', ')}\n`,
  );
  // @fitness-ignore-next-line async-waterfall-detection -- The closing Git snapshot must observe the source state after every measured task has finished.
  const taskResults = await executeTasks(tasks, arms, dependencies);
  const finalSource = await dependencies.resolveGitProvenance();
  const sourceState = classifySourceState(initialSource, finalSource);
  if (sourceState === 'changed-during-run') {
    void dependencies.stderr(
      'agent-eval: source revision changed during the run; report is non-promotable\n',
    );
  }
  const baseDefaultPath = defaultJsonPath(
    dependencies.resultsRoot,
    startedAtDate,
    cliVersion,
    initialSource.gitSha,
    sourceState,
  );
  const report: EvalReport = {
    cliVersion,
    completedAt: dependencies.now().toISOString(),
    contractFingerprint: fingerprint,
    gitSha: initialSource.gitSha,
    harnessVersion: dependencies.harnessVersion,
    nodeVersion: dependencies.nodeVersion,
    platform: dependencies.platform,
    promotionEligible: sourceState === 'clean',
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    selectedArms: arms,
    sourceState,
    startedAt,
    tasks: taskResults,
  };
  const paths = await persistReport(
    report,
    requestedPaths,
    baseDefaultPath,
    dependencies.artifactFileSystem,
  );
  void dependencies.stderr('agent-eval: report artifacts complete\n');
  printSuccess(paths, report, dependencies);
  return 0;
}

function boundedOneLine(message: string): string {
  const bounded = tailForDiagnostics(message, MAX_DIAGNOSTIC_BYTES)
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return bounded.length === 0 ? 'required evaluation inputs are unavailable.' : bounded;
}

function handleError(error: unknown, dependencies: CliDependencies): number {
  if (error instanceof InvocationError) {
    void dependencies.stderr(`agent-eval: ${boundedOneLine(error.message)}\n\n${USAGE}`);
    return 2;
  }
  if (error instanceof HarnessPrerequisiteError) {
    void dependencies.stderr(`agent-eval: prerequisite: ${boundedOneLine(error.message)}\n`);
    return 2;
  }
  if (error instanceof CliHarnessError) {
    void dependencies.stderr(`agent-eval: ${boundedOneLine(error.message)}\n`);
    return 1;
  }
  void dependencies.stderr('agent-eval: harness error; inspect the reported task and retry.\n');
  return 1;
}

async function mainImpl(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    void dependencies.stdout(USAGE);
    return 0;
  }
  const ids = knownTaskIds(dependencies.registry);
  if (options.list) {
    void dependencies.stdout(`${ids.join('\n')}\n`);
    return 0;
  }
  const tasks = selectTasks(options, dependencies.registry);
  const arms = selectedArms(options);
  const requestedPaths = buildRequestedPaths(options, dependencies);
  if (requestedPaths !== undefined) {
    await requireExplicitPairAvailable(requestedPaths, dependencies.artifactFileSystem);
  }
  return runEvaluation(tasks, arms, requestedPaths, dependencies);
}

/** Run the evaluation command without allowing task assertion failures to become process failures. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = DEFAULT_CLI_DEPENDENCIES,
): Promise<number> {
  try {
    return await mainImpl(argv, dependencies);
  } catch (error) {
    return handleError(error, dependencies);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
