/* eslint-disable @typescript-eslint/require-await -- driver stubs match contract `() => Promise<T>`; bodies throw synchronously until Phase 7 wires real drivers */
/**
 * @fileoverview Invariant-kind executor.
 *
 * Drives the `setup → act → assert` lifecycle, capturing per-phase status,
 * duration, and assertion verdicts. The executor:
 *   1. Builds an `InvariantContext` backed by the configured drivers (default
 *      = throw-NOT-IMPLEMENTED stubs; Phase 7 fills in real ones).
 *   2. Runs each phase, recording status + duration.
 *   3. Aborts gracefully on `AbortSignal`.
 *   4. Returns an `InvariantScenarioExecutorResult` carrying the phase log
 *      + the assertion records the assert phase produced.
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'


import type {
  InvariantContext,
  InvariantContextDeps,
  SeededTenantHandle,
  SeedTenantOptions,
  EmitSignalOptions,
  DispatchAgentOptions,
  StageExpectation,
  WorkflowStatusExpectation,
  AuditEntryExpectation,
  InvariantTicketProjection,
} from './context.js'
import type { InvariantScenarioConfig } from './define.js'
import type { InvariantAssertion, InvariantPhaseResult } from './result.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { InvariantScenarioExecutorResult } from '../../framework/scenario-executor-result.js'

// =============================================================================
// DEFAULT DRIVER STUBS
// =============================================================================

// @fitness-ignore-next-line throws-documentation -- closure always throws Error to surface unconfigured InvariantContext drivers; JSDoc cannot attach to a const-arrow
const NOT_IMPLEMENTED = (
  primitive: string,
): never => {
  // @fitness-ignore-next-line result-pattern-consistency -- intentionally throws to surface unconfigured drivers
  throw new Error(
    `InvariantContext.${primitive} is not yet implemented in the framework. ` +
      'Phase 7 (Invariant Scenarios) wires real drivers. Pass `deps.${primitive}` ' +
      'to defineInvariantScenario for a test-time fake.',
  )
}

const defaultDeps: InvariantContextDeps = {
  seedTenant: async (_options?: SeedTenantOptions): Promise<SeededTenantHandle> =>
    NOT_IMPLEMENTED('seedTenant'),
  emitSignal: async (_options: EmitSignalOptions) => NOT_IMPLEMENTED('emitSignal'),
  runReconcilerTick: async (_tenant: SeededTenantHandle) => NOT_IMPLEMENTED('runReconcilerTick'),
  queryTickets: async (
    _tenant: SeededTenantHandle,
    _filter?: { readonly status?: string; readonly fingerprint?: string },
  ): Promise<readonly InvariantTicketProjection[]> => NOT_IMPLEMENTED('queryTickets'),
  dispatchAgent: async (_options: DispatchAgentOptions) => NOT_IMPLEMENTED('dispatchAgent'),
  expectStage: async (_expectation: StageExpectation): Promise<boolean> =>
    NOT_IMPLEMENTED('expectStage'),
  expectOutcome: async (_traceId: string, _expectedOutcomeId: string): Promise<boolean> =>
    NOT_IMPLEMENTED('expectOutcome'),
  expectWorkflowStatus: async (_expectation: WorkflowStatusExpectation): Promise<boolean> =>
    NOT_IMPLEMENTED('expectWorkflowStatus'),
  expectAuditEntry: async (_expectation: AuditEntryExpectation): Promise<boolean> =>
    NOT_IMPLEMENTED('expectAuditEntry'),
}

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

interface ContextState {
  readonly assertions: InvariantAssertion[]
}

function buildContext(
  abortSignal: AbortSignal,
  deps: InvariantContextDeps,
  state: ContextState,
): InvariantContext {
  function record(
    description: string,
    held: boolean,
    details?: Record<string, unknown>,
  ): void {
    const entry: InvariantAssertion = details === undefined
      ? { description, held }
      : { description, held, details }
    state.assertions.push(entry)
  }

  return {
    abortSignal,
    seedTenant: (options) => deps.seedTenant(options),
    emitSignal: (options) => deps.emitSignal(options),
    runReconcilerTick: (tenant) => deps.runReconcilerTick(tenant),
    queryTickets: (tenant, filter) => deps.queryTickets(tenant, filter),
    dispatchAgent: (options) => deps.dispatchAgent(options),

    expectStage: async (expectation) => {
      const held = await deps.expectStage(expectation)
      const desc = expectation.outcomeId
        ? `stage ${expectation.stageId} reached with outcome ${expectation.outcomeId} on trace ${expectation.traceId}`
        : `stage ${expectation.stageId} reached on trace ${expectation.traceId}`
      record(desc, held, { ...expectation })
    },

    expectOutcome: async (traceId, expectedOutcomeId) => {
      const held = await deps.expectOutcome(traceId, expectedOutcomeId)
      record(
        `terminal outcome ${expectedOutcomeId} on trace ${traceId}`,
        held,
        { traceId, expectedOutcomeId },
      )
    },

    expectWorkflowStatus: async (expectation) => {
      const held = await deps.expectWorkflowStatus(expectation)
      record(
        `workflow ${expectation.workflowId} status = ${expectation.expectedStatus}`,
        held,
        { ...expectation },
      )
    },

    expectAuditEntry: async (expectation) => {
      const held = await deps.expectAuditEntry(expectation)
      record(
        `audit entry for subject=${expectation.subjectId} action=${expectation.action}`,
        held,
        { ...expectation },
      )
    },

    assertEquals: (actual, expected, description) => {
      const held = JSON.stringify(actual) === JSON.stringify(expected)
      record(description, held, { actual, expected })
    },

    assertThat: (condition, description, details) => {
      record(description, condition, details)
    },

    recordAssertion: (description, held, details) => {
      record(description, held, details)
    },
  }
}

// =============================================================================
// PHASE EXECUTION
// =============================================================================

/**
 * Run a single invariant-scenario phase (setup/act/assert), classifying any
 * caught error into a structured phase result. Aborts re-throw as
 * `ScenarioAbortedError` so the outer runner classifies them correctly.
 *
 * @throws {ScenarioAbortedError} When `abortSignal.aborted` is observed
 *   either at entry or during phase execution.
 */
async function runPhase(
  phaseName: 'setup' | 'act' | 'assert',
  fn: (ctx: InvariantContext) => Promise<void>,
  ctx: InvariantContext,
  abortSignal: AbortSignal,
): Promise<InvariantPhaseResult> {
  if (abortSignal.aborted) {
    // Match the abort contract used by the load/chaos kinds: throw
    // ScenarioAbortedError so the outer scenario runner classifies the
    // run as aborted, not as a normal phase failure.
    throw new ScenarioAbortedError()
  }
  const start = Date.now()
  try {
    await fn(ctx)
    return { phase: phaseName, status: 'passed', durationMs: Date.now() - start }
  } catch (error) {
    if (abortSignal.aborted || error instanceof ScenarioAbortedError) {
      throw error
    }
    return {
      phase: phaseName,
      status: 'failed',
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// =============================================================================
// RUNNABLE SCENARIO FACTORY
// =============================================================================

/** Build a `RunnableScenario` for an invariant-kind config. */
export function createInvariantScenarioRunner(
  config: InvariantScenarioConfig,
): RunnableScenario {
  const deps: InvariantContextDeps = { ...defaultDeps, ...config.deps }

  return Object.freeze({
    kind: 'invariant' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<InvariantScenarioExecutorResult> => {
        if (abortSignal.aborted) {
          throw new ScenarioAbortedError(config.id)
        }

        const startTime = Date.now()
        const state: ContextState = { assertions: [] }
        const ctx = buildContext(abortSignal, deps, state)

        const phases: InvariantPhaseResult[] = []

        const setup = await runPhase('setup', config.setup, ctx, abortSignal)
        phases.push(setup)

        const act: InvariantPhaseResult = setup.status === 'failed'
          ? { phase: 'act', status: 'failed', durationMs: 0, error: 'setup failed' }
          : await runPhase('act', config.act, ctx, abortSignal);
        phases.push(act)

        const assert: InvariantPhaseResult = act.status === 'failed'
          ? { phase: 'assert', status: 'failed', durationMs: 0, error: 'act failed' }
          : await runPhase('assert', config.assert, ctx, abortSignal);
        phases.push(assert)

        const allAssertionsHeld = state.assertions.every((a) => a.held)
        const allPhasesPassed = phases.every((p) => p.status === 'passed')
        const passed = allPhasesPassed && allAssertionsHeld

        return Object.freeze({
          kind: 'invariant' as const,
          scenarioId: config.id,
          passed,
          durationMs: Date.now() - startTime,
          signals: Object.freeze([]),
          outcome: Object.freeze({
            relatesToInvariant: config.relatesToInvariant,
            phases: Object.freeze(phases),
            assertions: Object.freeze([...state.assertions]),
          }),
        })
      },
  })
}
