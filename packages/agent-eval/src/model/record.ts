import type {
  AnswerFact,
  AnswerFactPattern,
  Arm,
  JsonObject,
  ProofClosureAssessment,
  ProofRelevance,
  ResolvedStrategyStep,
  RunLeg,
} from './task.js';

/** Whether a step exhausted its requested evidence domain. */
export type StepCompleteness = 'complete' | 'incomplete' | 'unknown';
/** Durable classification of an empty, failed, or non-empty step response. */
export type NoneOutcome = 'empty-complete' | 'empty-incomplete' | 'failed' | 'nonempty';

/** Completeness metadata for one graph-coverage facet. */
export interface CoverageFacetRecord {
  readonly complete: boolean;
  readonly hardCapReasons?: readonly string[];
  readonly name: 'evidence' | 'grouping' | 'inventory' | 'projection';
  readonly requested: boolean;
  readonly truncated: boolean;
}

/** Bounded coverage rollup retained for one evaluated step. */
export interface StepCoverage {
  readonly complete: boolean;
  readonly facets?: readonly CoverageFacetRecord[];
  readonly hardCapReasons?: readonly string[];
  readonly truncated: boolean;
}

/** Freshness evidence associated with a graph-backed step. */
export interface StepFreshness {
  readonly fresh: boolean;
  readonly reasonCode?: string;
  readonly verification: 'complete' | 'missing' | 'partial';
}

/** A normalized, non-throwing failure captured at a step boundary. */
export interface StepFailure {
  readonly code: string;
  readonly kind: 'binding' | 'infrastructure' | 'protocol' | 'tool';
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * Durable data for one invocation. The rendered response is intentionally not
 * present; only its byte count and normalized facts cross this boundary.
 */
export interface StepRecord {
  readonly argumentSummary: JsonObject;
  readonly catalogIdentity?: string;
  readonly completeness: StepCompleteness;
  readonly coverage?: StepCoverage;
  readonly expectedNonEmpty: boolean;
  readonly facts: readonly AnswerFact[];
  readonly failure?: StepFailure;
  readonly freshness?: StepFreshness;
  readonly leg: RunLeg;
  readonly nextCursor?: string;
  readonly noneOutcome: NoneOutcome;
  readonly absenceProofs: readonly AnswerFactPattern[];
  readonly proofClosure?: ProofClosureAssessment;
  readonly proofRelevance?: ProofRelevance;
  readonly responseBytes: number;
  readonly stepId: string;
  readonly tool: string;
  readonly truncated: boolean;
  readonly wallMs: number;
}

/** Inputs accepted by the sole durable step-record constructor. */
export interface MakeStepRecordInput {
  readonly catalogIdentity?: string;
  readonly completeness?: StepCompleteness;
  readonly coverage?: StepCoverage;
  readonly facts?: readonly AnswerFact[];
  readonly failure?: StepFailure;
  readonly freshness?: StepFreshness;
  readonly leg: RunLeg;
  readonly nextCursor?: string;
  readonly proofClosure?: ProofClosureAssessment;
  /** Used for byte accounting and discarded by the constructor. */
  readonly renderedResponse: string;
  /** The resolved step supplies identity, arguments, and response expectation. */
  readonly step: ResolvedStrategyStep;
  readonly truncated?: boolean;
  readonly wallMs: number;
}

function deriveCompleteness(input: MakeStepRecordInput, truncated: boolean): StepCompleteness {
  if (
    input.failure !== undefined ||
    truncated ||
    input.nextCursor !== undefined ||
    input.coverage?.complete === false ||
    (input.freshness !== undefined &&
      (!input.freshness.fresh || input.freshness.verification !== 'complete'))
  ) {
    return 'incomplete';
  }
  if (input.completeness !== undefined) return input.completeness;
  if (input.coverage?.complete === true) return 'complete';
  return 'unknown';
}

function deriveNoneOutcome(
  factCount: number,
  failure: StepFailure | undefined,
  completeness: StepCompleteness,
  truncated: boolean,
): NoneOutcome {
  if (failure !== undefined) return 'failed';
  if (factCount > 0) return 'nonempty';
  if (completeness === 'complete' && !truncated) return 'empty-complete';
  return 'empty-incomplete';
}

/** The sole StepRecord constructor and response-byte accounting boundary. */
export function makeStepRecord(input: MakeStepRecordInput): StepRecord {
  const facts = input.failure === undefined ? (input.facts ?? []) : [];
  const truncated = input.truncated === true || input.coverage?.truncated === true;
  const completeness = deriveCompleteness(input, truncated);
  return {
    absenceProofs: input.step.provesAbsence ?? [],
    argumentSummary: input.step.arguments,
    catalogIdentity: input.catalogIdentity,
    completeness,
    coverage: input.coverage,
    expectedNonEmpty: input.step.expectedNonEmpty,
    facts,
    failure: input.failure,
    freshness: input.freshness,
    leg: input.leg,
    nextCursor: input.nextCursor,
    noneOutcome: deriveNoneOutcome(facts.length, input.failure, completeness, truncated),
    proofClosure: input.proofClosure,
    proofRelevance: input.step.proofRelevance ?? 'projection',
    responseBytes: Buffer.byteLength(input.renderedResponse, 'utf8'),
    stepId: input.step.id,
    tool: input.step.tool,
    truncated,
    wallMs: input.wallMs,
  };
}

/** Timing and exit status for one fixture setup stage. */
export interface SetupStageRecord {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly name: string;
}

/** Byte-only metadata for bounded MCP stderr capture. */
export interface BoundedStderrMetadata {
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Successful initialize/get_agent_catalog/listTools setup provenance. */
export interface McpSetupProvenance {
  readonly handshakeDurationMs: number;
  readonly mutationPosture: 'mutations-enabled' | 'read-only';
  /** The handshake matched the requested canonical root; the absolute path is never persisted. */
  readonly projectRootVerified: boolean;
  readonly projectScope: 'project';
  readonly stderr: BoundedStderrMetadata;
  readonly surfaceEpoch: number;
  /** True only when initialize, catalog, and listTools surfaces agree. */
  readonly surfaceVerified: boolean;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly version: string;
}

/** Setup provenance kept separate from measured task-step cost. */
export interface SetupRecord {
  /** Setup-only evidence: never included in task-step cost. */
  readonly catalogProbe?: CatalogProbeRecord;
  readonly mcp?: McpSetupProvenance;
  readonly mode: 'fixture' | 'reuse-existing';
  readonly stages: readonly SetupStageRecord[];
}

/** Cost and identity recorded for an unmeasured catalog prerequisite probe. */
export interface CatalogProbeRecord {
  readonly catalogIdentity: string;
  readonly durationMs: number;
  readonly responseBytes: number;
}

/** Durable steps and optional applied edits for one run leg. */
export interface ArmLegRecord {
  /** Relative paths only; attached to the post-edit leg that follows them. */
  readonly appliedEdits?: readonly AppliedEditRecord[];
  readonly leg: RunLeg;
  readonly steps: readonly StepRecord[];
}

/** A content-free record of one mutation applied to a fixture copy. */
export interface AppliedEditRecord {
  readonly kind: 'append' | 'delete' | 'write';
  readonly path: string;
}

/** Durable execution record for one task arm. */
export interface ArmRunRecord {
  readonly arm: Arm;
  readonly legs: readonly ArmLegRecord[];
  readonly setup: SetupRecord;
  readonly strategyVersion: string;
  readonly taskId: string;
}

/** Paired arm records and completion time for one evaluated task. */
export interface TaskRunRecord {
  readonly arms: Readonly<Record<Arm, ArmRunRecord>>;
  readonly completedAt: string;
  readonly taskId: string;
}

/** The evaluator's only tool-effect seam. */
export type ToolInvoker = (step: ResolvedStrategyStep) => Promise<StepRecord>;
