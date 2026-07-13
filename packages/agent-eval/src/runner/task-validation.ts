import { HarnessPrerequisiteError } from './spawn.js';

import type { FixtureResolution } from './fixture-resolution.js';
import type { GoldTask, RunLeg, ScopedAnswerAssertions, StrategyStep } from '../model/task.js';

const MUTATING_MCP_TOOLS = new Set(['refresh_graph', 'repair_apply_verify']);

export function assertionsForLeg(task: GoldTask, leg: RunLeg): ScopedAnswerAssertions {
  const scoped = task.assertions.scoped?.find((entry) => entry.leg === leg);
  if (leg !== 'main') return scoped ?? { leg };
  return {
    leg,
    mustExclude: [...(task.assertions.mustExclude ?? []), ...(scoped?.mustExclude ?? [])],
    mustInclude: [...(task.assertions.mustInclude ?? []), ...(scoped?.mustInclude ?? [])],
  };
}

/**
 * Enforce the single-refresh recovery contract for a staleness task.
 *
 * @throws {HarnessPrerequisiteError} When refresh appears outside or after the recovery start.
 */
function assertRecoveryShape(task: GoldTask): void {
  const recovery = task.staleness?.recoverySteps?.opensip;
  if (recovery !== undefined && recovery.length > 0 && recovery[0]?.tool !== 'refresh_graph') {
    throw new HarnessPrerequisiteError(
      `Task ${task.id} OpenSIP recovery must begin with refresh_graph.`,
    );
  }
  const outsideRecovery = [
    ...task.strategies.opensip.steps,
    ...(task.staleness?.postEditSteps.opensip ?? []),
  ];
  if (outsideRecovery.some((step) => step.tool === 'refresh_graph')) {
    throw new HarnessPrerequisiteError(
      `Task ${task.id} may use refresh_graph only in its recovery leg.`,
    );
  }
}

function allTaskSteps(task: GoldTask): readonly StrategyStep[] {
  return [
    ...task.strategies.control.steps,
    ...task.strategies.opensip.steps,
    ...(task.staleness?.postEditSteps.control ?? []),
    ...(task.staleness?.postEditSteps.opensip ?? []),
    ...(task.staleness?.recoverySteps?.control ?? []),
    ...(task.staleness?.recoverySteps?.opensip ?? []),
  ];
}

/**
 * Reject edits and mutating tools from tasks that reuse the repository.
 *
 * @throws {HarnessPrerequisiteError} When a dogfood task can mutate repository state.
 */
function assertDogfoodReadOnly(task: GoldTask): void {
  if (task.staleness !== undefined) {
    throw new HarnessPrerequisiteError(
      `Dogfood task ${task.id} must not declare edits or staleness legs.`,
    );
  }
  if (allTaskSteps(task).some((step) => MUTATING_MCP_TOOLS.has(step.tool))) {
    throw new HarnessPrerequisiteError(
      `Dogfood task ${task.id} must not invoke a mutating MCP tool.`,
    );
  }
}

export function validateTask(task: GoldTask, fixture: FixtureResolution): void {
  if (fixture.mode === 'reuse-existing') assertDogfoodReadOnly(task);
  assertRecoveryShape(task);
}
