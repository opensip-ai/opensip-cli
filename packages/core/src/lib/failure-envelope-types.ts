/** Public type surface for canonical normalized failures. */

import type { ErrorDefinition, FAILURE_PROJECTION_SCHEMA_VERSION } from './error-definition.js';

/** Whether a normalized failure matched a known definition or degraded to unknown. */
export type FailureKnownStatus = 'known' | 'unknown';

/** One entry in a failure's bounded cause chain. */
export interface FailureCauseSummary {
  readonly code?: string;
  readonly name?: string;
  readonly message: string;
  readonly known: FailureKnownStatus;
}

/** Canonical, frozen representation of any thrown value. */
export interface FailureEnvelope {
  readonly schemaVersion: typeof FAILURE_PROJECTION_SCHEMA_VERSION;
  readonly known: FailureKnownStatus;
  readonly message: string;
  readonly operatorAction: string;
  readonly code: string;
  readonly definition: ErrorDefinition;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly failureClass?: string;
  readonly causes: readonly FailureCauseSummary[];
  /** Sibling failures from parallel fan-in (not a cause chain). */
  readonly aggregate?: readonly FailureEnvelope[];
  readonly aggregateTruncated?: boolean;
  /** Operator-only detail (never public/worker by default). */
  readonly operatorDetail?: string;
}

/** Optional context passed to failure normalization. */
export interface NormalizeFailureContext {
  readonly projectRoot?: string;
  /** Optional sibling failures for aggregate envelopes. */
  readonly siblings?: readonly unknown[];
}
