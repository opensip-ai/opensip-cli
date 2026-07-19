/**
 * Serializable host-support projection TYPE for agent-facing catalogs (Plan 02
 * — macOS GA qualification, Task 4.2).
 *
 * This is the contracts-layer mirror of core's `RuntimeHostSupportProjection`.
 * Contracts owns ONLY the serializable shape; it never inspects the process
 * and never touches the filesystem. The single pure core→contracts mapper
 * (`hostSupportFromRuntimeProjection`) lives in @opensip-cli/shared-analysis
 * (Plan 09 Phase 7): the CLI and MCP composition roots observe the live
 * process, call core's `projectRuntimeHostSupport`, and map the result through
 * that one helper — so both surfaces emit a BYTE-IDENTICAL `hostSupport` for
 * identical process facts (the Plan 03 catalog-parity handoff depends on this
 * single mapping site).
 *
 * Because the projection is built only from process-observable facts
 * (platform / arch / Node version / Node ABI), the match level is NEVER
 * `exact`: npm, filesystem, case behavior, OS product version, kernel
 * name/version, and install channel are unobserved at runtime. The `match` field is therefore typed
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
 * dimensions (npm / filesystem / install channel / OS and kernel identity) were not
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
