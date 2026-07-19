/**
 * Host-support projection MAPPER (Plan 02 — macOS GA qualification, Task 4.2).
 *
 * The serializable {@link AgentHostSupport} shape lives in
 * @opensip-cli/contracts; this module owns the single pure core→contracts
 * mapping site. The CLI and MCP composition roots observe the live process,
 * call core's `projectRuntimeHostSupport`, and map the result through
 * {@link hostSupportFromRuntimeProjection} — so both surfaces emit a
 * BYTE-IDENTICAL `hostSupport` for identical process facts (the Plan 03
 * catalog-parity handoff depends on this single mapping site).
 */

import type { AgentHostSupport } from '@opensip-cli/contracts';

/** Mirror of the contracts-side closed status vocabulary (structural). */
type AgentHostSupportStatus = 'supported' | 'preview' | 'unqualified' | 'unsupported';

/**
 * The structural subset of core's `RuntimeHostSupportProjection` the mapper
 * reads. Declared locally (not imported) so the mapper stays a pure
 * data-to-data projection; core's projection is structurally assignable to it.
 */
interface RuntimeHostSupportProjectionInput {
  readonly status: AgentHostSupportStatus;
  readonly match: 'partial' | 'none';
  readonly rowId: string | null;
  readonly rowStatus: AgentHostSupportStatus | null;
  readonly profile: { readonly id: string; readonly version: number } | null;
  readonly docsUrl: string | null;
  readonly reasonCodes: readonly string[];
  readonly observed: readonly string[];
  readonly unobserved: readonly string[];
}

/**
 * Map core's runtime host-support projection to the serializable
 * {@link AgentHostSupport} shape. Pure and deterministic: identical input
 * (plus the same `contractVersion`) produces a byte-identical object, so the
 * CLI and MCP catalogs agree exactly. `match` is carried through unchanged and
 * can only ever be `'partial'` or `'none'` — `exact` is unreachable from
 * process-only facts.
 *
 * @param projection The result of core `projectRuntimeHostSupport(facts)`.
 * @param contractVersion `PLATFORM_SUPPORT_CONTRACT_VERSION` from core.
 */
export function hostSupportFromRuntimeProjection(
  projection: RuntimeHostSupportProjectionInput,
  contractVersion: number,
): AgentHostSupport {
  return {
    supportContractVersion: contractVersion,
    status: projection.status,
    match: projection.match,
    rowId: projection.rowId,
    rowStatus: projection.rowStatus,
    profile:
      projection.profile === null
        ? null
        : { id: projection.profile.id, version: projection.profile.version },
    matrixUrl: projection.docsUrl,
    reasonCodes: [...projection.reasonCodes],
    observed: [...projection.observed],
    unobserved: [...projection.unobserved],
  };
}
