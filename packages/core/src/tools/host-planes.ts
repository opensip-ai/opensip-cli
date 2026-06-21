/**
 * @fileoverview Host-owned governance / audit / entitlements planes.
 *
 * The stable (but minimal) interfaces for the host-provided governance /
 * audit / entitlements planes, plus the lightweight / forward-compatible
 * record types they exchange. Surfaced on {@link ToolCliContext} via the
 * `hostPlanes` evolution bag. Split out of the kitchen-sink `types.ts`
 * contract hub (M6); re-exported from there so the public surface is
 * unchanged.
 */

/**
 * Stable (but minimal) interfaces for the host-provided governance / audit / entitlements planes.
 * These are defined in core so that both the host (CLI) and consumers (Cloud, future community tools)
 * have a single source of truth.
 *
 * Cloud is the primary consumer. Third-party / OSS tool authors may:
 *   - ignore the bag entirely, or
 *   - use the existing `toolState` seam directly for custom records, or
 *   - supply compatible objects (the host will prefer a supplied implementation when present).
 *
 * See the governing "Host-Planes / Scope-Seams Hygiene" spec (local-only
 * working doc under docs/plans/, by that title) for the flexibility story.
 */
export interface HostGovernance {
  /** Read the current governance state blob for a tool (installed/enabled/block/approvals). */
  getGovernanceState(toolId: string): Promise<ToolGovernanceState | undefined>;
  listForProject(projectRoot: string): Promise<ToolGovernanceState[]>;
  queryAudit(toolId: string, filter?: unknown): Promise<AuditEntry[]>;

  recordInstallation(toolId: string, record: InstallationRecord): Promise<void>;
  recordApprovalDecision(toolId: string, decision: ApprovalDecision): Promise<void>;
  setBlock(toolId: string, blocked: boolean, reason?: string): Promise<void>;

  /** Enforcement helper (used by run paths or Cloud before acting on a tool). */
  checkAllowed(
    toolId: string,
    action: 'install' | 'enable' | 'run-remediation' | 'run-simulation',
  ): Promise<boolean>;
}

/**
 * Host-owned audit plane (hostPlanes.audit). Tools append per-tool audit
 * entries and query them back; the host persists them (Cloud primary, OSS
 * compat via tool_state). Cloud may additionally chain entries into its
 * WORM/tamper-evident log via {@link HostAudit.exportForCloud}.
 */
export interface HostAudit {
  /** Append one audit entry for `toolId` (host persists it). */
  append(toolId: string, entry: ToolAuditEntry): Promise<void>;
  /** Read back `toolId`'s audit entries, optionally narrowed by `filter`. */
  query(toolId: string, filter?: unknown): Promise<ToolAuditEntry[]>;
  /** Best-effort linkage point for Cloud's WORM/tamper-evident audit chain. */
  exportForCloud?(...args: unknown[]): Promise<unknown>;
}

/**
 * Host-owned entitlements plane (hostPlanes.entitlements). Tools check whether
 * an action is licensed, record usage for metering, and read the current
 * license state. OSS hosts may supply permissive compat implementations.
 */
export interface HostEntitlements {
  /** Resolve the entitlement status for `toolId` (optionally for a specific `action`). */
  check(toolId: string, action?: string): Promise<EntitlementStatus>;
  /** Record a usage event for `toolId` (metering / quota accounting). */
  recordUsage(toolId: string, usage: UsageRecord): Promise<void>;
  /** Read the current license state for `toolId`, or `undefined` if unknown. */
  getLicenseState(toolId: string): Promise<LicenseState | undefined>;
}

/**
 * Lightweight / forward-compatible record types for the host-owned
 * governance/entitlements/audit plane.
 *
 * These are intentionally minimal in the first cut. Most fields are either
 * opaque to the CLI today or will be interpreted by Cloud/Community surfaces.
 * The host (via hostPlanes seams) performs serialization into the existing
 * namespaced tool_state rows. See the governing spec for full rationale and
 * evolution path.
 */
export type ToolGovernanceState = Record<string, unknown>;
/** Opaque record describing a tool installation (host/Cloud-interpreted). */
export type InstallationRecord = Record<string, unknown>;
/** Opaque record of an install/enable approval decision (host/Cloud-interpreted). */
export type ApprovalDecision = Record<string, unknown>;
/** Opaque governance audit entry recorded via {@link HostGovernance.queryAudit}. */
export type AuditEntry = Record<string, unknown>;
/** Opaque per-tool audit entry appended/queried via {@link HostAudit}. */
export type ToolAuditEntry = Record<string, unknown>;
/** Opaque entitlement-check result returned by {@link HostEntitlements.check}. */
export type EntitlementStatus = Record<string, unknown>;
/** Opaque usage event recorded via {@link HostEntitlements.recordUsage}. */
export type UsageRecord = Record<string, unknown>;
/** Opaque license-state snapshot returned by {@link HostEntitlements.getLicenseState}. */
export type LicenseState = Record<string, unknown>;
