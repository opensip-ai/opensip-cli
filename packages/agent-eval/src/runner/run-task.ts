import { createNativeInvoker } from '../adapters/native-tools.js';
import { fixtureHomePath, setupFixtureProject } from '../adapters/opensip-cli.js';
import { McpArmSession } from '../adapters/opensip-mcp.js';
import { evaluateAssertions } from '../scorer/assertions.js';
import { computeArmMetrics, computeRecoveryMetrics } from '../scorer/metrics.js';

import { applyEditScript } from './edit-applier.js';
import { executeArm } from './execute-arm.js';
import { listGitVisibleFixtureFiles } from './fixture-inventory.js';
import { REUSE_EXISTING_MODE, resolveFixtureReference } from './fixture-resolution.js';
import { withFixtureCopy } from './fixture-workspace.js';
import { HarnessPrerequisiteError } from './spawn.js';
import { assertionsForLeg, validateTask } from './task-validation.js';

import type { FixtureResolution, FixtureResolutionOptions } from './fixture-resolution.js';
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

/** Injectable effect seams used while executing one task or arm. */
export interface RunTaskDependencies {
  readonly applyEdit: typeof applyEditScript;
  readonly connectMcp: (
    workspaceRoot: string,
    mode: SetupRecord['mode'],
  ) => Promise<TaskMcpSession>;
  readonly createControlInvoker: typeof createNativeInvoker;
  readonly execute: typeof executeArm;
  readonly listFixtureFiles: typeof listGitVisibleFixtureFiles;
  readonly now: () => Date;
  readonly setupFixture: typeof setupFixtureProject;
  readonly withFixture: typeof withFixtureCopy;
}

/** Fixture roots and optional effect overrides for task execution. */
export interface RunTaskOptions extends FixtureResolutionOptions {
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
  connectMcp: (workspaceRoot: string, mode: SetupRecord['mode']) =>
    McpArmSession.connect(buildMcpSessionOptions(workspaceRoot, mode)),
  createControlInvoker: createNativeInvoker,
  execute: executeArm,
  listFixtureFiles: listGitVisibleFixtureFiles,
  now: () => new Date(),
  setupFixture: setupFixtureProject,
  withFixture: withFixtureCopy,
});

/** Keep fixture init/graph/MCP on the same isolated HOME without touching dogfood. */
export function buildMcpSessionOptions(
  workspaceRoot: string,
  mode: SetupRecord['mode'],
): McpArmSessionOptions {
  return {
    ...(mode === 'fixture' ? { env: { HOME: fixtureHomePath(workspaceRoot) } } : {}),
    workspaceRoot,
  };
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
        steps: task.strategies[arm].steps,
      }),
    ];
  }

  const preEdit = await dependencies.execute({
    assertions: assertionsForLeg(task, 'pre-edit'),
    invoker,
    leg: 'pre-edit',
    steps: task.strategies[arm].steps,
  });
  const appliedEdits = dependencies.applyEdit(workspaceRoot, task.staleness.edit);
  const postEditResult = await dependencies.execute({
    assertions: assertionsForLeg(task, 'post-edit'),
    invoker,
    leg: 'post-edit',
    steps: task.staleness.postEditSteps[arm],
  });
  const postEdit = { ...postEditResult, appliedEdits };
  const recoverySteps = task.staleness.recoverySteps?.[arm] ?? [];
  if (recoverySteps.length === 0) return [preEdit, postEdit];
  const recovery = await dependencies.execute({
    assertions: assertionsForLeg(task, 'recovery'),
    invoker,
    leg: 'recovery',
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
) {
  const session = await dependencies.connectMcp(workspaceRoot, setup.mode);
  let legs: Awaited<ReturnType<typeof executeTaskLegs>>;
  let catalogProbe: CatalogProbeRecord;
  try {
    const invoker = session.invoker();
    // @fitness-ignore-next-line async-waterfall-detection -- Task reads must start only after the required fresh catalog probe has passed.
    catalogProbe = await requireGraphCatalog(task, invoker, setup.mode);
    legs = await executeTaskLegs(task, 'opensip', invoker, workspaceRoot, dependencies);
  } finally {
    await session.close();
  }
  const mcp: McpSetupProvenance = session.provenance();
  return evaluateArm(task, 'opensip', { ...setup, catalogProbe, mcp }, legs);
}

async function runFixtureArm(
  task: GoldTask,
  arm: Arm,
  fixture: Extract<FixtureResolution, { readonly mode: 'fixture' }>,
  dependencies: RunTaskDependencies,
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
          const setup = await dependencies.setupFixture(root, fixture.language);
          return runOpenSipWithSession(task, root, setup, dependencies);
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
): Promise<EvaluatedArmRun> {
  return fixture.mode === 'fixture'
    ? runFixtureArm(task, arm, fixture, dependencies)
    : runDogfoodArm(task, arm, fixture.workspaceRoot, dependencies);
}

/** Execute exactly one requested arm without constructing a synthetic peer record. */
export function runTaskArm(
  task: GoldTask,
  arm: Arm,
  options: RunTaskOptions = {},
): Promise<EvaluatedArmRun> {
  const fixture = resolveFixtureReference(task.fixture, options);
  validateTask(task, fixture);
  return runResolvedTaskArm(task, arm, fixture, resolveDependencies(options));
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
  const control = await runResolvedTaskArm(task, 'control', fixture, dependencies);
  const opensip = await runResolvedTaskArm(task, 'opensip', fixture, dependencies);
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
