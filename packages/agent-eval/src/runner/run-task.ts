import { createNativeInvoker } from '../adapters/native-tools.js';
import {
  DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES,
  fixtureHomePath,
  setupFixtureProject,
} from '../adapters/opensip-cli.js';
import { McpArmSession } from '../adapters/opensip-mcp.js';
import { evaluateAssertions } from '../scorer/assertions.js';
import { computeArmMetrics, computeRecoveryMetrics } from '../scorer/metrics.js';

import { applyEditScript } from './edit-applier.js';
import { safeErrorDetail } from './error-detail.js';
import { executeArm } from './execute-arm.js';
import { listGitVisibleFixtureFiles } from './fixture-inventory.js';
import { REUSE_EXISTING_MODE, resolveFixtureReference } from './fixture-resolution.js';
import { withFixtureCopy } from './fixture-workspace.js';
import { HarnessPrerequisiteError, assertTargetRealpathStable, spawnCli } from './spawn.js';
import { assertionsForLeg, validateTask } from './task-validation.js';

import type { FixtureResolution, FixtureResolutionOptions } from './fixture-resolution.js';
import type { CliTarget } from './spawn.js';
import type { SetupFixtureProjectDependencies } from '../adapters/opensip-cli.js';
import type { McpArmSessionOptions } from '../adapters/opensip-mcp.js';
import type {
  ArmRunRecord,
  CatalogProbeRecord,
  McpSetupProvenance,
  SetupRecord,
  TaskRunRecord,
  ToolInvoker,
} from '../model/record.js';
import type { Arm, GoldTask, ResolvedStrategyStep } from '../model/task.js';
import type { AssertionResult } from '../scorer/assertions.js';
import type { ArmMetrics, RecoveryMetrics } from '../scorer/metrics.js';

export { DOGFOOD_FIXTURE_REFERENCE, resolveFixtureReference } from './fixture-resolution.js';
export type { FixtureResolution, FixtureResolutionOptions } from './fixture-resolution.js';

type TaskMcpSession = Pick<McpArmSession, 'close' | 'invoker' | 'provenance'>;

type CapturedOperation<T> =
  | { readonly error: unknown; readonly success: false }
  | { readonly success: true; readonly value: T };

async function captureOperation<T>(operation: () => Promise<T>): Promise<CapturedOperation<T>> {
  try {
    return { success: true, value: await operation() };
  } catch (error) {
    return { error, success: false };
  }
}

class OpenSipArmLifecycleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OpenSipArmLifecycleError';
  }
}

function preserveExecutionAndCloseFailures(
  executionError: unknown,
  closeError: unknown,
  workspaceRoot: string,
): Error {
  const sensitivePaths = [workspaceRoot];
  const executionDetail = safeErrorDetail(executionError, sensitivePaths) || 'unknown failure';
  const closeDetail = safeErrorDetail(closeError, sensitivePaths) || 'unknown failure';
  const message = `${executionDetail} Related MCP session-close failure: ${closeDetail}`;
  return executionError instanceof HarnessPrerequisiteError
    ? new HarnessPrerequisiteError(message)
    : new OpenSipArmLifecycleError(message);
}

/** Injectable effect seams used while executing one task or arm. */
export interface RunTaskDependencies {
  readonly applyEdit: typeof applyEditScript;
  readonly connectMcp: (
    workspaceRoot: string,
    mode: SetupRecord['mode'],
    target?: CliTarget,
    maxToolCalls?: number,
  ) => Promise<TaskMcpSession>;
  readonly createControlInvoker: typeof createNativeInvoker;
  readonly execute: typeof executeArm;
  readonly listFixtureFiles: typeof listGitVisibleFixtureFiles;
  readonly now: () => Date;
  readonly setupFixture: (
    projectRoot: string,
    language: string,
    target?: CliTarget,
  ) => Promise<SetupRecord>;
  readonly withFixture: typeof withFixtureCopy;
}

/** Fixture roots and optional effect overrides for task execution. */
export interface RunTaskOptions extends FixtureResolutionOptions {
  /** The immutable CLI target every init/graph/MCP spawn measures (workspace `dist` when absent). */
  readonly cliTarget?: CliTarget;
  readonly dependencies?: Partial<RunTaskDependencies>;
}

/** Paired arm records, assertions, and cost metrics for one completed task. */
export interface EvaluatedTaskRun {
  readonly assertions: Readonly<Record<Arm, AssertionResult>>;
  readonly metrics: Readonly<Record<Arm, ArmMetrics>>;
  readonly record: TaskRunRecord;
  /** Recovery calls are deliberately excluded from the primary arm metrics. */
  readonly recoveryMetrics: Readonly<Record<Arm, RecoveryMetrics>>;
}

/** Record, assertions, and metrics for one independently executed arm. */
export interface EvaluatedArmRun {
  readonly assertions: AssertionResult;
  readonly metrics: ArmMetrics;
  readonly record: ArmRunRecord;
  readonly recoveryMetrics: RecoveryMetrics;
}

const DEFAULT_RUN_TASK_DEPENDENCIES: RunTaskDependencies = Object.freeze({
  applyEdit: applyEditScript,
  connectMcp: (
    workspaceRoot: string,
    mode: SetupRecord['mode'],
    target?: CliTarget,
    maxToolCalls?: number,
  ) => McpArmSession.connect(buildMcpSessionOptions(workspaceRoot, mode, target, maxToolCalls)),
  createControlInvoker: createNativeInvoker,
  execute: executeArm,
  listFixtureFiles: listGitVisibleFixtureFiles,
  now: () => new Date(),
  setupFixture: (projectRoot: string, language: string, target?: CliTarget) =>
    setupFixtureProject(projectRoot, language, setupFixtureDependenciesForTarget(target)),
  withFixture: withFixtureCopy,
});

/** Bind an explicit CLI target into fixture setup's init/graph spawns (workspace `dist` when absent). */
function setupFixtureDependenciesForTarget(
  target: CliTarget | undefined,
): SetupFixtureProjectDependencies {
  if (target === undefined) return DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES;
  return {
    ...DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES,
    spawnCli: (args, options) => spawnCli(args, { ...options, target }),
  };
}

/** Keep fixture init/graph/MCP on the same isolated HOME and CLI target without touching dogfood. */
export function buildMcpSessionOptions(
  workspaceRoot: string,
  mode: SetupRecord['mode'],
  target?: CliTarget,
  maxToolCalls?: number,
): McpArmSessionOptions {
  return {
    ...(mode === 'fixture' ? { env: { HOME: fixtureHomePath(workspaceRoot) } } : {}),
    ...(target === undefined
      ? {}
      : {
          cliCommand: target.command,
          cliPreludeArgs: target.executionPrelude,
          cliDistResolver: () =>
            target.source === 'installed' ? target.executionEntrypoint : target.entrypoint,
          targetStabilityCheck: () => assertTargetRealpathStable(target),
        }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    workspaceRoot,
  };
}

/** Exact post-handshake MCP call budget for one OpenSIP arm, including its catalog probe. */
export function opensipToolCallBudget(task: GoldTask): number {
  if (task.staleness === undefined) return 1 + task.strategies.opensip.steps.length;
  return (
    1 +
    task.strategies.opensip.steps.length +
    task.staleness.postEditSteps.opensip.length +
    (task.staleness.recoverySteps?.opensip.length ?? 0)
  );
}

const CATALOG_PREREQUISITE_PROBE: ResolvedStrategyStep = Object.freeze({
  arguments: { limit: 1, sections: ['metrics'], topN: 1 },
  expectedNonEmpty: false,
  extract: () => [],
  id: 'catalog-prerequisite',
  rationale: 'Verify that setup produced or reused a persisted graph catalog.',
  tool: 'get_architecture',
});

async function executeTaskLegs(
  task: GoldTask,
  arm: Arm,
  invoker: ToolInvoker,
  workspaceRoot: string,
  dependencies: RunTaskDependencies,
) {
  if (task.staleness === undefined) {
    return [
      await dependencies.execute({
        assertions: assertionsForLeg(task, 'main'),
        invoker,
        leg: 'main',
        sensitivePaths: [workspaceRoot],
        steps: task.strategies[arm].steps,
      }),
    ];
  }

  const preEdit = await dependencies.execute({
    assertions: assertionsForLeg(task, 'pre-edit'),
    invoker,
    leg: 'pre-edit',
    sensitivePaths: [workspaceRoot],
    steps: task.strategies[arm].steps,
  });
  const appliedEdits = dependencies.applyEdit(workspaceRoot, task.staleness.edit);
  const postEditResult = await dependencies.execute({
    assertions: assertionsForLeg(task, 'post-edit'),
    invoker,
    leg: 'post-edit',
    sensitivePaths: [workspaceRoot],
    steps: task.staleness.postEditSteps[arm],
  });
  const postEdit = { ...postEditResult, appliedEdits };
  const recoverySteps = task.staleness.recoverySteps?.[arm] ?? [];
  if (recoverySteps.length === 0) return [preEdit, postEdit];
  const recovery = await dependencies.execute({
    assertions: assertionsForLeg(task, 'recovery'),
    invoker,
    leg: 'recovery',
    sensitivePaths: [workspaceRoot],
    steps: recoverySteps,
  });
  return [preEdit, postEdit, recovery];
}

function evaluateArm(
  task: GoldTask,
  arm: Arm,
  setup: SetupRecord,
  legs: Awaited<ReturnType<typeof executeTaskLegs>>,
): EvaluatedArmRun {
  const record: ArmRunRecord = {
    arm,
    legs,
    setup,
    strategyVersion: task.strategies[arm].version,
    taskId: task.id,
  };
  return {
    assertions: evaluateAssertions(record, task.assertions),
    metrics: computeArmMetrics(record, task.assertions),
    record,
    recoveryMetrics: computeRecoveryMetrics(record),
  };
}

async function runControlArm(
  task: GoldTask,
  workspaceRoot: string,
  mode: SetupRecord['mode'],
  dependencies: RunTaskDependencies,
  allowedPaths?: readonly string[],
) {
  const legs = await executeTaskLegs(
    task,
    'control',
    dependencies.createControlInvoker(workspaceRoot, {
      ...(allowedPaths === undefined ? {} : { allowedPaths }),
    }),
    workspaceRoot,
    dependencies,
  );
  return evaluateArm(task, 'control', { mode, stages: [] }, legs);
}

/**
 * Verify that setup produced a fresh, complete graph catalog.
 *
 * @throws {HarnessPrerequisiteError} When the required catalog cannot be queried safely.
 */
async function requireGraphCatalog(
  task: GoldTask,
  invoker: ToolInvoker,
  mode: SetupRecord['mode'],
): Promise<CatalogProbeRecord> {
  const record = await invoker(CATALOG_PREREQUISITE_PROBE);
  if (
    record.failure !== undefined ||
    record.catalogIdentity?.startsWith('g1:') !== true ||
    record.completeness !== 'complete' ||
    record.truncated ||
    record.nextCursor !== undefined ||
    record.coverage?.complete === false ||
    record.coverage?.truncated === true ||
    record.freshness?.fresh !== true ||
    record.freshness.verification !== 'complete'
  ) {
    const message =
      mode === REUSE_EXISTING_MODE
        ? `Dogfood task ${task.id} requires a pre-existing graph catalog; run \`pnpm graph\` first.`
        : `Fixture setup for task ${task.id} did not produce a queryable graph catalog.`;
    throw new HarnessPrerequisiteError(message);
  }
  return {
    catalogIdentity: record.catalogIdentity,
    durationMs: record.wallMs,
    responseBytes: record.responseBytes,
  };
}

async function runOpenSipWithSession(
  task: GoldTask,
  workspaceRoot: string,
  setup: SetupRecord,
  dependencies: RunTaskDependencies,
  target: CliTarget | undefined,
) {
  const session = await dependencies.connectMcp(
    workspaceRoot,
    setup.mode,
    target,
    opensipToolCallBudget(task),
  );
  const execution = await captureOperation(async () => {
    const invoker = session.invoker();
    // @fitness-ignore-next-line async-waterfall-detection -- Task reads must start only after the required fresh catalog probe has passed.
    const catalogProbe = await requireGraphCatalog(task, invoker, setup.mode);
    const legs = await executeTaskLegs(task, 'opensip', invoker, workspaceRoot, dependencies);
    return { catalogProbe, legs };
  });
  const closing = await captureOperation(() => session.close());
  if (!execution.success) {
    if (!closing.success) {
      throw preserveExecutionAndCloseFailures(execution.error, closing.error, workspaceRoot);
    }
    throw execution.error;
  }
  if (!closing.success) throw closing.error;
  const mcp: McpSetupProvenance = session.provenance();
  return evaluateArm(
    task,
    'opensip',
    { ...setup, catalogProbe: execution.value.catalogProbe, mcp },
    execution.value.legs,
  );
}

async function runFixtureArm(
  task: GoldTask,
  arm: Arm,
  fixture: Extract<FixtureResolution, { readonly mode: 'fixture' }>,
  dependencies: RunTaskDependencies,
  target: CliTarget | undefined,
): Promise<EvaluatedArmRun> {
  switch (arm) {
    case 'control': {
      return dependencies.withFixture(
        {
          fixtureDirectory: fixture.sourceRoot,
          repositoryRoot: fixture.repositoryRoot,
        },
        (root) => runControlArm(task, root, 'fixture', dependencies),
      );
    }
    case 'opensip': {
      return dependencies.withFixture(
        {
          fixtureDirectory: fixture.sourceRoot,
          repositoryRoot: fixture.repositoryRoot,
        },
        async (root) => {
          const setup = await dependencies.setupFixture(root, fixture.language, target);
          return runOpenSipWithSession(task, root, setup, dependencies, target);
        },
      );
    }
    default: {
      const exhaustive: never = arm;
      return exhaustive;
    }
  }
}

async function runDogfoodArm(
  task: GoldTask,
  arm: Arm,
  workspaceRoot: string,
  dependencies: RunTaskDependencies,
  target: CliTarget | undefined,
): Promise<EvaluatedArmRun> {
  switch (arm) {
    case 'control': {
      const files = await dependencies.listFixtureFiles(workspaceRoot, workspaceRoot);
      return runControlArm(
        task,
        workspaceRoot,
        REUSE_EXISTING_MODE,
        dependencies,
        files.map((file) => file.relativePath),
      );
    }
    case 'opensip': {
      return runOpenSipWithSession(
        task,
        workspaceRoot,
        { mode: REUSE_EXISTING_MODE, stages: [] },
        dependencies,
        target,
      );
    }
    default: {
      const exhaustive: never = arm;
      return exhaustive;
    }
  }
}

function resolveDependencies(options: RunTaskOptions): RunTaskDependencies {
  return {
    ...DEFAULT_RUN_TASK_DEPENDENCIES,
    ...options.dependencies,
  };
}

function runResolvedTaskArm(
  task: GoldTask,
  arm: Arm,
  fixture: FixtureResolution,
  dependencies: RunTaskDependencies,
  target: CliTarget | undefined,
): Promise<EvaluatedArmRun> {
  return fixture.mode === 'fixture'
    ? runFixtureArm(task, arm, fixture, dependencies, target)
    : runDogfoodArm(task, arm, fixture.workspaceRoot, dependencies, target);
}

/** Execute exactly one requested arm without constructing a synthetic peer record. */
export function runTaskArm(
  task: GoldTask,
  arm: Arm,
  options: RunTaskOptions = {},
): Promise<EvaluatedArmRun> {
  const fixture = resolveFixtureReference(task.fixture, options);
  validateTask(task, fixture);
  return runResolvedTaskArm(task, arm, fixture, resolveDependencies(options), options.cliTarget);
}

/** Run both deterministic arms sequentially and return records plus scoring. */
export async function runTask(
  task: GoldTask,
  options: RunTaskOptions = {},
): Promise<EvaluatedTaskRun> {
  const fixture = resolveFixtureReference(task.fixture, options);
  validateTask(task, fixture);
  const dependencies = resolveDependencies(options);
  // @fitness-ignore-next-line async-waterfall-detection -- Arms run serially to preserve deterministic order and prevent competing CLI/MCP processes from contaminating timing.
  const control = await runResolvedTaskArm(
    task,
    'control',
    fixture,
    dependencies,
    options.cliTarget,
  );
  const opensip = await runResolvedTaskArm(
    task,
    'opensip',
    fixture,
    dependencies,
    options.cliTarget,
  );
  const record: TaskRunRecord = {
    arms: { control: control.record, opensip: opensip.record },
    completedAt: dependencies.now().toISOString(),
    taskId: task.id,
  };
  return {
    assertions: {
      control: control.assertions,
      opensip: opensip.assertions,
    },
    metrics: { control: control.metrics, opensip: opensip.metrics },
    record,
    recoveryMetrics: {
      control: control.recoveryMetrics,
      opensip: opensip.recoveryMetrics,
    },
  };
}
