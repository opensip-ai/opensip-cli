/**
 * @fileoverview Verdict policy — the host-owned findings gate (ADR-0035).
 *
 * A run's pass/fail is one value, `envelope.verdict.passed`, computed from the
 * run's error/warning counts against a tool-declared findings policy. The policy
 * is two reserved config keys — `failOnErrors` / `failOnWarnings` — recognized in
 * EVERY tool's config namespace, with a host fallback of `{1, 0}` (fail on any
 * error, warnings informational) when a tool declares neither.
 *
 * Lives in `lib/` next to {@link ./severity-policy} (the error/warning split it
 * pairs with), NOT under `tools/`: `resolveVerdictPolicy` reads
 * `currentScope().toolConfig`, and `run-scope.ts` imports `tools/registry.js`, so
 * a `tools/ → run-scope` edge would reintroduce a cycle (see `tools/types.ts`).
 * `contracts` imports {@link VerdictPolicy} / {@link policyPasses} from here the
 * same way it imports `SeverityPolicy`.
 */

import { currentScope } from './run-scope.js';

/** The findings gate for a run: fail when counts cross either threshold. */
export interface VerdictPolicy {
  /** Fail when `errors >= failOnErrors`; `0` disables the error gate. */
  readonly failOnErrors: number;
  /** Fail when `warnings >= failOnWarnings`; `0` disables the warning gate. */
  readonly failOnWarnings: number;
}

/**
 * Host fallback applied when a tool declares neither reserved key: fail on any
 * error, warnings informational. This is fit's historical default generalized to
 * every tool (graph/sim inherit it, reproducing their `errors > 0 ⇒ fail`).
 */
export const HOST_VERDICT_POLICY_FALLBACK: VerdictPolicy = {
  failOnErrors: 1,
  failOnWarnings: 0,
};

/**
 * The findings predicate: `true` ⇔ the run passes its policy. Pure. Mirrors
 * fit's pre-ADR-0035 threshold (`result-builders.ts`) exactly — a `> 0` threshold
 * is active, `0` disables that rung. Execution faults are handled by the caller
 * (the envelope's `runFaulted` / unit `error`), not here.
 */
export function policyPasses(
  counts: { readonly errors: number; readonly warnings: number },
  policy: VerdictPolicy,
): boolean {
  const failsOnErrors = policy.failOnErrors > 0 && counts.errors >= policy.failOnErrors;
  const failsOnWarnings = policy.failOnWarnings > 0 && counts.warnings >= policy.failOnWarnings;
  return !failsOnErrors && !failsOnWarnings;
}

/** A resolved config value is a usable threshold only if it is a non-negative int. */
function asThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Resolve a tool's findings policy from its config namespace. Reads the already-
 * resolved `currentScope().toolConfig?.[toolNamespace]` (ADR-0023 applied the
 * flag>env>file>defaults precedence upstream); this only extracts the two
 * reserved keys and applies {@link HOST_VERDICT_POLICY_FALLBACK} per-key, so a
 * tool may declare one key and inherit the other.
 */
export function resolveVerdictPolicy(toolNamespace: string): VerdictPolicy {
  const ns = currentScope()?.toolConfig?.[toolNamespace];
  return {
    failOnErrors: asThreshold(ns?.failOnErrors) ?? HOST_VERDICT_POLICY_FALLBACK.failOnErrors,
    failOnWarnings: asThreshold(ns?.failOnWarnings) ?? HOST_VERDICT_POLICY_FALLBACK.failOnWarnings,
  };
}
