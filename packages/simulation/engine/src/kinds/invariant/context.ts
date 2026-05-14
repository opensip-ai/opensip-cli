/**
 * @fileoverview `InvariantContext` — API surface for invariant scenarios.
 *
 * Invariant scenarios run a `setup → act → assert` lifecycle. The context
 * exposes the primitives Plan 01 Phase 7's pilot scenarios will reach for:
 *
 *   - Tenant/repo seeding (`seedTenant`)
 *   - Signal emission into the pipeline (`emitSignal`)
 *   - Reconciler tick driving (`runReconcilerTick`)
 *   - Ticket queries (`queryTickets`)
 *   - Agent dispatch (`dispatchAgent`)
 *   - Trace pipeline assertions (`expectStage`, `expectOutcome`)
 *   - DBOS workflow assertions (`expectWorkflowStatus`)
 *   - Audit chain assertions (`expectAuditEntry`)
 *   - Generic deep-equality (`assertEquals`) and predicate (`assertThat`) helpers
 *   - Phase recording (`recordAssertion`) — the assert phase calls this for each
 *     invariant it checks; the executor collects them into the outcome.
 *
 * Per Phase 0b.5's framework-first scope, primitives that require real
 * infrastructure (Postgres, DBOS, agent harness) ship as throw-NOT-IMPLEMENTED
 * stubs in the default driver — Phase 7's pilot work fills them in. The TYPE
 * SIGNATURES are load-bearing now: they're what authors program against.
 *
 * Per Phase 7's "validate framework contract before scaling" guidance, the
 * primitives below are the explicit contract authors program against. New
 * primitives are added through the framework (not ad-hoc per scenario).
 */

import type { Signal, CreateSignalInput } from '@opensip-tools/core'

/** Reference to a seeded tenant. Opaque to scenario authors. */
export interface SeededTenantHandle {
  readonly tenantId: string
  readonly repoIds: readonly string[]
}

/** Options for `seedTenant`. */
export interface SeedTenantOptions {
  readonly tenantSlug?: string
  readonly repos?: readonly { readonly name: string; readonly defaultBranch?: string }[]
}

/** Options for `emitSignal`. */
export interface EmitSignalOptions {
  readonly tenant: SeededTenantHandle
  readonly signal: CreateSignalInput
}

/** A simplified ticket projection returned by `queryTickets`. */
export interface InvariantTicketProjection {
  readonly id: string
  readonly status: string
  readonly fingerprint: string
  readonly signalIds: readonly string[]
}

/** Options for `dispatchAgent`. */
export interface DispatchAgentOptions {
  readonly ticketId: string
  readonly tenant: SeededTenantHandle
}

/** Verdict for a workflow-status assertion. */
export interface WorkflowStatusExpectation {
  readonly workflowId: string
  readonly expectedStatus: string
}

/** Verdict for an audit-entry assertion. */
export interface AuditEntryExpectation {
  readonly subjectId: string
  readonly action: string
}

/** Verdict for a pipeline-stage assertion. */
export interface StageExpectation {
  readonly traceId: string
  readonly stageId: string
  readonly outcomeId?: string
}

/**
 * Invariant scenario context — the API authors program against in
 * `setup` / `act` / `assert` phases.
 */
export interface InvariantContext {
  /** Abort signal — every awaitable check should respect it. */
  readonly abortSignal: AbortSignal

  // ---- Seeding -----------------------------------------------------------

  /** Seed a tenant + (optionally) repos. */
  seedTenant(options?: SeedTenantOptions): Promise<SeededTenantHandle>

  // ---- Signal/pipeline drivers ------------------------------------------

  /** Emit a signal as if it came from the named source. */
  emitSignal(options: EmitSignalOptions): Promise<Signal>

  /** Drive one reconciler tick for the tenant. */
  runReconcilerTick(tenant: SeededTenantHandle): Promise<void>

  /** Query tickets currently visible for the tenant. */
  queryTickets(
    tenant: SeededTenantHandle,
    filter?: { readonly status?: string; readonly fingerprint?: string },
  ): Promise<readonly InvariantTicketProjection[]>

  /** Dispatch a fix agent against a ticket. */
  dispatchAgent(options: DispatchAgentOptions): Promise<void>

  // ---- Assertion helpers (assert phase) ---------------------------------

  /** Assert a pipeline trace stage's outcome. Records the assertion. */
  expectStage(expectation: StageExpectation): Promise<void>

  /** Assert a pipeline trace outcome on the terminal stage. */
  expectOutcome(traceId: string, expectedOutcomeId: string): Promise<void>

  /** Assert a DBOS workflow's status. */
  expectWorkflowStatus(expectation: WorkflowStatusExpectation): Promise<void>

  /** Assert that an audit chain entry exists for the subject. */
  expectAuditEntry(expectation: AuditEntryExpectation): Promise<void>

  /** Generic deep-equality assertion. Records the assertion. */
  assertEquals<T>(actual: T, expected: T, description: string): void

  /** Generic predicate assertion. Records the assertion. */
  assertThat(condition: boolean, description: string, details?: Record<string, unknown>): void

  /** Lower-level: record an assertion verdict directly. */
  recordAssertion(description: string, held: boolean, details?: Record<string, unknown>): void
}

/**
 * Drivers the executor wires into `InvariantContext`. The default driver
 * (composed in `executor.ts`) ships throw-NOT-IMPLEMENTED stubs for every
 * primitive that needs real infrastructure — Phase 7's pilot work fills
 * them in. Test scenarios may pass a fake driver via the executor's
 * `withDeps(...)` hook.
 */
export interface InvariantContextDeps {
  readonly seedTenant: (options?: SeedTenantOptions) => Promise<SeededTenantHandle>
  readonly emitSignal: (options: EmitSignalOptions) => Promise<Signal>
  readonly runReconcilerTick: (tenant: SeededTenantHandle) => Promise<void>
  readonly queryTickets: (
    tenant: SeededTenantHandle,
    filter?: { readonly status?: string; readonly fingerprint?: string },
  ) => Promise<readonly InvariantTicketProjection[]>
  readonly dispatchAgent: (options: DispatchAgentOptions) => Promise<void>
  readonly expectStage: (expectation: StageExpectation) => Promise<boolean>
  readonly expectOutcome: (traceId: string, expectedOutcomeId: string) => Promise<boolean>
  readonly expectWorkflowStatus: (expectation: WorkflowStatusExpectation) => Promise<boolean>
  readonly expectAuditEntry: (expectation: AuditEntryExpectation) => Promise<boolean>
}
