/**
 * host-planes — builder for the `hostPlanes` evolution bag on ToolCliContext.
 *
 * This wires the combined Host-Owned Governance, Entitlements, and Audit Plane.
 * Storage is delegated to the existing toolState seam / ToolStateRepo (namespaced
 * keys under the single host-owned `tool_state` table per ADR-0042).
 *
 * The builder is intentionally small and host-owned (cli package). Core only
 * defines the shape in ToolCliContext.
 *
 * Real method bodies for governance/audit/entitlements land in subsequent phases.
 * This phase only ensures the bag is constructed and attached so the type is
 * satisfied and the surface exists for tools + host commands.
 */
import type { Logger } from '@opensip-tools/core';

import type { ToolCliContext } from '@opensip-tools/core';

/**
 * Build the hostPlanes bag.
 *
 * For the initial wiring (this phase) we return a bag with stub implementations
 * that satisfy the core type. Later phases replace the bodies with real
 * namespaced reads/writes + the business logic from the spec.
 */
export function buildHostPlanes(_opts: {
  getDatastore: () => any;
  logger?: Logger;
}): ToolCliContext['hostPlanes'] {
  // Stubs preserve additivity: governance checks default to "allowed",
  // reads return undefined/empty, writes are no-ops. Real logic (and use of
  // the datastore for namespaced toolState puts/gets) is added in Phases 2-4.
  return {
    governance: {
      async getGovernanceState(_toolId: string) {
        return undefined;
      },
      async listForProject(_projectRoot: string) {
        return [];
      },
      async queryAudit(_toolId: string, _filter?: unknown) {
        return [];
      },
      async recordInstallation(_toolId: string, _record: unknown) {
        // no-op in wiring phase
      },
      async recordApprovalDecision(_toolId: string, _decision: unknown) {
        // no-op in wiring phase
      },
      async setBlock(_toolId: string, _blocked: boolean, _reason?: string) {
        // no-op in wiring phase
      },
      async checkAllowed(_toolId: string, _action: unknown) {
        // Default permissive in the wiring phase (additive, no GA breakage).
        // Real policy evaluation lands when governance state is populated.
        return true;
      },
    },
    audit: {
      async append(_toolId: string, _entry: unknown) {
        // no-op; real append (with chunking under cap) in Phase 3
      },
      async query(_toolId: string, _filter?: unknown) {
        return [];
      },
      async exportForCloud(..._args: unknown[]) {
        // best-effort hook for Cloud WORM linkage (Phase 3)
        return {};
      },
    },
    entitlements: {
      async check(_toolId: string, _action?: string) {
        // Default "entitled" for GA-era / private / undeclared tools.
        return { entitled: true } as any;
      },
      async recordUsage(_toolId: string, _usage: unknown) {
        // no-op
      },
      async getLicenseState(_toolId: string) {
        return undefined;
      },
    },
  };
}
