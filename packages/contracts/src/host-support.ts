/**
 * Serializable host-support projection for agent-facing catalogs (Plan 02 —
 * macOS GA qualification, Task 4.2).
 *
 * This is the contracts-layer mirror of core's `RuntimeHostSupportProjection`.
 * Contracts owns ONLY the serializable shape and the pure core→contracts mapper;
 * it never imports `@opensip-cli/core`, never inspects the process, and never
 * touches the filesystem. The CLI and MCP composition roots observe the live
 * process, call core's `projectRuntimeHostSupport`, and map the result through
 * the single {@link hostSupportFromRuntimeProjection} helper here — so both
 * surfaces emit a BYTE-IDENTICAL `hostSupport` for identical process facts
 * (the Plan 03 catalog-parity handoff depends on this single mapping site).
 *
 * Because the projection is built only from process-observable facts
 * (platform / arch / Node version / Node ABI), the match level is NEVER
 * `exact`: npm, filesystem, case behavior, OS/kernel version, and install
 * channel are unobserved at runtime. The `match` field is therefore typed
 * `'partial' | 'none'`, making `exact` structurally unrepresentable here.
 */

/**
 * The closed platform-support status vocabulary, mirrored for serialization
 * (spec §3). Kept in lockstep with core's `PlatformSupportStatus`; contracts
 * cannot import core, so the union is re-declared as data.
 */
type AgentHostSupportStatus = 'supported' | 'preview' | 'unqualified' | 'unsupported';

/** Digest-free acceptance-profile reference (mirrors core `PlatformSupportProfileRef`). */
interface AgentHostSupportProfile {
  readonly id: string;
  readonly version: number;
}

/**
 * The honest, process-only host-support projection attached to an
 * {@link AgentCatalog}. Advertises the matched registry row's published status
 * (e.g. `preview`) while keeping `match: 'partial'` whenever normative
 * dimensions (npm / filesystem / install channel / OS-kernel version) were not
 * observed. A contradicted dimension yields `match: 'none'` with reason codes.
 */
export interface AgentHostSupport {
  /** The platform-support contract version this projection was built against. */
  readonly supportContractVersion: number;
  /** Effective classification status (may advertise the matched row's status). */
  readonly status: AgentHostSupportStatus;
  /** Degree of match from process-only facts — NEVER `exact`. */
  readonly match: 'partial' | 'none';
  /** The matched registry row id, or `null` when no row applies. */
  readonly rowId: string | null;
  /** The matched row's published status, or `null`. */
  readonly rowStatus: AgentHostSupportStatus | null;
  /** The matched row's acceptance profile, or `null`. */
  readonly profile: AgentHostSupportProfile | null;
  /** Public support-matrix URL for this claim, or `null`. */
  readonly matrixUrl: string | null;
  /** Stable, kebab-case mismatch/classification reason codes (empty on a clean partial). */
  readonly reasonCodes: readonly string[];
  /** Normative dimensions observed from the process facts. */
  readonly observed: readonly string[];
  /** Normative dimensions left unobserved at runtime. */
  readonly unobserved: readonly string[];
}

/**
 * The structural subset of core's `RuntimeHostSupportProjection` the mapper
 * reads. Declared locally (not imported) so contracts stays free of a core
 * dependency; core's projection is structurally assignable to it.
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
