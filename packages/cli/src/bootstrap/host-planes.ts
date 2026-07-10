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
import { ToolStateRepo, type DataStore } from '@opensip-cli/datastore';

import { hostPlaneStateIdentity } from './host-plane-state.js';

import type {
  HostGovernance,
  HostAudit,
  HostEntitlements,
  Logger,
  ToolCliContext,
} from '@opensip-cli/core';

/**
 * Build the hostPlanes bag.
 *
 * Real implementations for the three sub-planes. Storage uses the reserved
 * host-plane identity `@opensip-cli/host-plane:<toolId>` over the existing
 * host-owned `tool_state` table (via ToolStateRepo) so tool-owned
 * governance/audit/entitlements keys cannot collide (ADR-0146).
 */
export function buildHostPlanes(opts: {
  getDatastore: () => DataStore;
  logger?: Logger;
}): ToolCliContext['hostPlanes'] {
  const log = opts.logger;
  let repo: ToolStateRepo | undefined;

  const getRepo = (): ToolStateRepo => {
    if (!repo) {
      const ds = opts.getDatastore();
      repo = new ToolStateRepo(ds);
    }
    return repo;
  };

  // Simple read-modify-write helpers for object blobs under a top-level key.
  // Public method arguments keep the ordinary tool id; storage maps through
  // hostPlaneStateIdentity immediately before ToolStateRepo.
  const readBlob = <T>(toolId: string, key: string): T | undefined => {
    return getRepo().get(hostPlaneStateIdentity(toolId), key) as T | undefined;
  };
  const writeBlob = (toolId: string, key: string, value: unknown) => {
    getRepo().put(hostPlaneStateIdentity(toolId), key, value);
  };

  const governanceImpl: HostGovernance = {
    async getGovernanceState(toolId: string) {
      await Promise.resolve();
      return readBlob<Record<string, unknown>>(toolId, 'governance');
    },
    async queryAudit(toolId: string, _filter?: unknown) {
      await Promise.resolve();
      const entries = readBlob<Record<string, unknown>[]>(toolId, 'audit') ?? [];
      return entries;
    },
    async recordInstallation(toolId: string, record: unknown) {
      const current = readBlob<Record<string, unknown>>(toolId, 'governance') ?? {};
      writeBlob(toolId, 'governance', {
        ...current,
        installed: true,
        lastInstallation: record,
        updatedAt: Date.now(),
      });
      if (log) log.debug({ evt: 'cli.governance.install-recorded', tool: toolId });
      await Promise.resolve();
    },
    async recordApprovalDecision(toolId: string, decision: unknown) {
      const current = readBlob<Record<string, unknown>>(toolId, 'governance') ?? {};
      const approvals = (current.approvals as unknown[] | undefined) ?? [];
      writeBlob(toolId, 'governance', {
        ...current,
        approvals: [...approvals, decision],
        updatedAt: Date.now(),
      });
      await Promise.resolve();
    },
    async setBlock(toolId: string, blocked: boolean, reason?: string) {
      const current = readBlob<Record<string, unknown>>(toolId, 'governance') ?? {};
      writeBlob(toolId, 'governance', {
        ...current,
        blocked,
        blockReason: reason,
        updatedAt: Date.now(),
      });
      await Promise.resolve();
    },
    async checkAllowed(toolId: string, _action: unknown) {
      await Promise.resolve();
      const state = readBlob<Record<string, unknown>>(toolId, 'governance') ?? {};
      // Default allow for tools without explicit governance record (additive).
      return !state.blocked;
    },
  };

  const auditImpl: HostAudit = {
    async append(toolId: string, entry: unknown) {
      const current: Record<string, unknown>[] = readBlob(toolId, 'audit') ?? [];
      const withTs = { ...(entry as Record<string, unknown>), ts: Date.now() };
      const next = [...current, withTs];
      // Simple (no chunking yet). If over cap the underlying repo will throw
      // ValidationError — matches the spec's "chunk if needed" escape hatch.
      writeBlob(toolId, 'audit', next);
      if (log) log.debug({ evt: 'cli.audit.append', tool: toolId });
      await Promise.resolve();
    },
    async query(toolId: string, _filter?: unknown) {
      await Promise.resolve();
      return readBlob<Record<string, unknown>[]>(toolId, 'audit') ?? [];
    },
  };

  const entitlementsImpl: HostEntitlements = {
    async check(toolId: string, _action?: string) {
      await Promise.resolve();
      const state = readBlob<Record<string, unknown>>(toolId, 'entitlements') ?? {};
      // Default entitled for anything not explicitly recorded (GA additive).
      if (!state || Object.keys(state).length === 0) {
        return { entitled: true, source: 'default' };
      }
      return state;
    },
    async recordUsage(toolId: string, usage: unknown) {
      const current = readBlob<Record<string, unknown>>(toolId, 'entitlements') ?? {};
      writeBlob(toolId, 'entitlements', {
        ...current,
        lastUsage: usage,
        updatedAt: Date.now(),
      });
      await Promise.resolve();
    },
    async getLicenseState(toolId: string) {
      await Promise.resolve();
      const state = readBlob<Record<string, unknown>>(toolId, 'entitlements') ?? {};
      return state.license as Record<string, unknown> | undefined;
    },
  };

  return {
    governance: governanceImpl,
    audit: auditImpl,
    entitlements: entitlementsImpl,
  };
}
