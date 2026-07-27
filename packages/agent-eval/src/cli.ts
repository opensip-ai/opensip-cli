import { basename, dirname, join, resolve } from 'node:path';
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
import { installAgentEvalProcessBoundary } from './process-boundary.js';
import { contractFingerprint } from './report/contract-fingerprint.js';
import { EVAL_REPORT_SCHEMA_VERSION } from './report/model.js';
import { safeErrorDetail } from './runner/error-detail.js';
import { resolveGitProvenance } from './runner/git-provenance.js';
import { registerInterruptCleanup } from './runner/interrupt-cleanup.js';
import { runTaskArm } from './runner/run-task.js';
import {
  HarnessPrerequisiteError,
  assertTargetFinalStable,
  buildCliTarget,
  cleanupCliTarget,
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
import type { CliTarget } from './runner/spawn.js';

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
  readonly resolveCliVersion: (target: CliTarget) => Promise<string>;
  readonly resolveGitProvenance: () => Promise<GitProvenance>;
  readonly resultsRoot: string;
  readonly runArm: (task: GoldTask, arm: Arm, target: CliTarget) => Promise<EvaluatedArmRun>;
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

/**
 * Resolve the target CLI's version through the harness's bounded CLI spawn seam.
 * Uses the same immutable target as every other spawn in the run.
 *
 * @throws {HarnessPrerequisiteError} When the built CLI or a valid version is unavailable.
 */
export async function resolveOpenSipCliVersion(target: CliTarget): Promise<string> {
  // The installed entrypoint was verified at target construction; only a workspace
  // target needs the "run pnpm build" prerequisite check before spawning.
  if (target.source === 'workspace') void resolveCliDist();
  const result = await spawnCli(['--version'], {
    maxOutputBytes: VERSION_OUTPUT_BYTES,
    target,
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
  runArm: (task: GoldTask, arm: Arm, target: CliTarget) =>
    runTaskArm(task, arm, { cliTarget: target }),
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
  target: CliTarget,
  dependencies: CliDependencies,
): Promise<readonly EvalTaskResult[]> {
  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    const armResults: Partial<Record<Arm, EvalArmResult>> = {};
    for (const arm of arms) {
      void dependencies.stderr(`agent-eval: ${task.id} [${arm}] starting\n`);
      armResults[arm] = await dependencies.runArm(task, arm, target);
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
  target: CliTarget,
  dependencies: CliDependencies,
): Promise<number> {
  const startedAtDate = dependencies.now();
  const startedAt = startedAtDate.toISOString();
  const [cliVersion, initialSource] = await Promise.all([
    dependencies.resolveCliVersion(target),
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
  const taskResults = await executeTasks(tasks, arms, target, dependencies);
  const finalSource = await dependencies.resolveGitProvenance();
  // Re-hash the complete installed target once, after all target process
  // boundaries have performed metadata checks and before evidence is trusted.
  assertTargetFinalStable(target);
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
    cliTarget:
      target.source === 'installed'
        ? {
            entrypointName: basename(target.entrypoint),
            entrypointSha256: `sha256:${target.entrypointIdentity.sha256}`,
            packageJsonSha256: `sha256:${target.packageJsonIdentity.sha256}`,
            source: 'installed',
          }
        : { entrypointName: basename(target.entrypoint), source: 'workspace' },
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

function unclassifiedHarnessDetail(error: unknown, dependencies: CliDependencies): string {
  const sensitivePaths = [dependencies.resultsRoot];
  try {
    sensitivePaths.push(dependencies.cwd());
  } catch {
    // The original failure remains authoritative if cwd resolution is itself unavailable.
  }
  let identity = 'UnknownFailure';
  if (error instanceof Error) {
    try {
      identity = error.name.trim() || 'Error';
    } catch {
      identity = 'Error';
    }
  }
  const detail = safeErrorDetail(error, sensitivePaths) || 'failure detail unavailable';
  return safeErrorDetail(new Error(`${identity}: ${detail}`), sensitivePaths);
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
  void dependencies.stderr(
    `agent-eval: harness error: ${boundedOneLine(unclassifiedHarnessDetail(error, dependencies))}\n`,
  );
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
  // Construct the one immutable CLI target once, after help/list have returned, so
  // every version/init/graph/MCP spawn in this run measures the same build.
  const target = buildCliTarget(options.opensipEntrypoint);
  let targetCleaned = false;
  const cleanupTarget = (): void => {
    if (targetCleaned) return;
    targetCleaned = true;
    cleanupCliTarget(target);
  };
  const releaseInterruptCleanup = registerInterruptCleanup(cleanupTarget);
  try {
    const requestedPaths = buildRequestedPaths(options, dependencies);
    if (requestedPaths !== undefined) {
      await requireExplicitPairAvailable(requestedPaths, dependencies.artifactFileSystem);
    }
    return await runEvaluation(tasks, arms, requestedPaths, target, dependencies);
  } finally {
    releaseInterruptCleanup();
    cleanupTarget();
  }
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
  const uninstallProcessBoundary = installAgentEvalProcessBoundary((reason, kind) =>
    handleError(
      new CliHarnessError(
        `fatal ${kind}: ${unclassifiedHarnessDetail(reason, DEFAULT_CLI_DEPENDENCIES)}`,
      ),
      DEFAULT_CLI_DEPENDENCIES,
    ),
  );
  try {
    process.exitCode = await main(process.argv.slice(2));
  } finally {
    uninstallProcessBoundary();
  }
}
