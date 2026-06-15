/**
 * createSignalFromViolation — the generic identity-stamping signal factory
 * (north-star §5.9, launch).
 *
 * Generalizes fitness's `violationToSignal`: a tool hands a flat violation
 * (`message`, author `severity`, location, optional suggestion) plus its
 * `toolSource` + rule `slug`, and the factory STAMPS the `Signal` identity —
 * `source`, `ruleId`, and the wire `severity` (via {@link SeverityPolicy}) — so an
 * author never retypes fingerprint-relevant identity. Output is byte-identical to
 * the per-tool hand-mapping it replaces.
 */

import { SeverityPolicy, type AuthorSeverity } from '../lib/severity-policy.js';
import { createSignal, type Signal } from '../types/signal.js';

/** A flat violation: a message at a location with an author-level severity. */
export interface ViolationInput {
  readonly message: string;
  readonly severity: AuthorSeverity;
  readonly suggestion?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Build a {@link Signal} from a violation, stamping `source`/`ruleId` from the
 * tool + slug and the wire `severity` from the policy. `category` defaults to the
 * neutral `quality` (via `createSignal`); the location rides on `code`.
 */
export function createSignalFromViolation(
  toolSource: string,
  slug: string,
  violation: ViolationInput,
): Signal {
  return createSignal({
    source: toolSource,
    ruleId: slug,
    severity: SeverityPolicy.liftAuthorSeverity(violation.severity),
    message: violation.message,
    suggestion: violation.suggestion,
    code: { file: violation.file, line: violation.line, column: violation.column },
  });
}
