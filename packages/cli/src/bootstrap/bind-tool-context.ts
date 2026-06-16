/**
 * bind-tool-context — mount-time guard for tool-scoped host planes.
 *
 * The host-owned baseline, toolState, governance, audit, and entitlement planes
 * are all keyed by a `tool` string for backward compatibility with the public
 * ToolCliContext. The mounted command already has an owning Tool, so bind that
 * ownership into a thin context wrapper and reject accidental or malicious
 * cross-tool keys before they reach persistence.
 */

import { PluginIncompatibleError, type Tool, type ToolCliContext } from '@opensip-cli/core';

import type { RunActionHooks } from './run-plane.js';

type BoundToolCliContext = ToolCliContext & RunActionHooks;

function primaryCommandName(tool: Tool): string | undefined {
  return tool.commandSpecs?.[0]?.name ?? tool.commands[0]?.name;
}

export function toolOwnedKeys(tool: Tool): ReadonlySet<string> {
  return new Set(
    [
      tool.metadata.id,
      tool.metadata.name,
      primaryCommandName(tool),
      tool.sessionReplay?.tool,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
}

function describeTool(tool: Tool): string {
  return tool.metadata.name || tool.metadata.id;
}

function assertOwnToolKey(
  tool: Tool,
  allowed: ReadonlySet<string>,
  requested: string,
  seam: string,
): void {
  if (allowed.has(requested)) return;
  throw new PluginIncompatibleError(
    `tool '${describeTool(tool)}' attempted to use ${seam} for tool namespace '${requested}'. ` +
      `Allowed namespaces: ${[...allowed].sort().join(', ')}.`,
    {
      code: 'PLUGIN.IDENTITY_NAMESPACE_MISMATCH',
      diagnostic: `cross-tool ${seam} namespace '${requested}'`,
    },
  );
}

function wrapHostPlanes(
  tool: Tool,
  allowed: ReadonlySet<string>,
  hostPlanes: ToolCliContext['hostPlanes'],
): ToolCliContext['hostPlanes'] {
  if (hostPlanes === undefined) return undefined;
  return {
    ...(hostPlanes.governance
      ? {
          governance: {
            getGovernanceState: (toolId) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.getGovernanceState');
              return hostPlanes.governance!.getGovernanceState(toolId);
            },
            listForProject: hostPlanes.governance.listForProject.bind(hostPlanes.governance),
            queryAudit: (toolId, filter) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.queryAudit');
              return hostPlanes.governance!.queryAudit(toolId, filter);
            },
            recordInstallation: (toolId, record) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.recordInstallation');
              return hostPlanes.governance!.recordInstallation(toolId, record);
            },
            recordApprovalDecision: (toolId, decision) => {
              assertOwnToolKey(
                tool,
                allowed,
                toolId,
                'hostPlanes.governance.recordApprovalDecision',
              );
              return hostPlanes.governance!.recordApprovalDecision(toolId, decision);
            },
            setBlock: (toolId, blocked, reason) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.setBlock');
              return hostPlanes.governance!.setBlock(toolId, blocked, reason);
            },
            checkAllowed: (toolId, action) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.checkAllowed');
              return hostPlanes.governance!.checkAllowed(toolId, action);
            },
          },
        }
      : {}),
    ...(hostPlanes.audit
      ? {
          audit: {
            append: (toolId, entry) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.audit.append');
              return hostPlanes.audit!.append(toolId, entry);
            },
            query: (toolId, filter) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.audit.query');
              return hostPlanes.audit!.query(toolId, filter);
            },
            ...(hostPlanes.audit.exportForCloud
              ? { exportForCloud: hostPlanes.audit.exportForCloud.bind(hostPlanes.audit) }
              : {}),
          },
        }
      : {}),
    ...(hostPlanes.entitlements
      ? {
          entitlements: {
            check: (toolId, action) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.check');
              return hostPlanes.entitlements!.check(toolId, action);
            },
            recordUsage: (toolId, usage) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.recordUsage');
              return hostPlanes.entitlements!.recordUsage(toolId, usage);
            },
            getLicenseState: (toolId) => {
              assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.getLicenseState');
              return hostPlanes.entitlements!.getLicenseState(toolId);
            },
          },
        }
      : {}),
  };
}

export function bindToolCliContext(tool: Tool, ctx: ToolCliContext): BoundToolCliContext {
  const allowed = toolOwnedKeys(tool);
  const source = ctx as object;
  const bound = {} as BoundToolCliContext;
  Object.defineProperties(bound, Object.getOwnPropertyDescriptors(source));

  Object.defineProperties(bound, {
    saveBaseline: {
      value: (toolId: string, envelope: unknown) => {
        assertOwnToolKey(tool, allowed, toolId, 'saveBaseline');
        return ctx.saveBaseline(toolId, envelope);
      },
    },
    compareBaseline: {
      value: (toolId: string, envelope: unknown) => {
        assertOwnToolKey(tool, allowed, toolId, 'compareBaseline');
        return ctx.compareBaseline(toolId, envelope);
      },
    },
    exportBaselineSarif: {
      value: (toolId: string, path: string) => {
        assertOwnToolKey(tool, allowed, toolId, 'exportBaselineSarif');
        return ctx.exportBaselineSarif(toolId, path);
      },
    },
    exportBaselineFingerprints: {
      value: (toolId: string, path: string) => {
        assertOwnToolKey(tool, allowed, toolId, 'exportBaselineFingerprints');
        return ctx.exportBaselineFingerprints(toolId, path);
      },
    },
    toolState: {
      value: {
        get: (toolId: string, key: string) => {
          assertOwnToolKey(tool, allowed, toolId, 'toolState.get');
          return ctx.toolState.get(toolId, key);
        },
        put: (toolId: string, key: string, payload: unknown) => {
          assertOwnToolKey(tool, allowed, toolId, 'toolState.put');
          return ctx.toolState.put(toolId, key, payload);
        },
        delete: (toolId: string, key: string) => {
          assertOwnToolKey(tool, allowed, toolId, 'toolState.delete');
          return ctx.toolState.delete(toolId, key);
        },
        list: (toolId: string) => {
          assertOwnToolKey(tool, allowed, toolId, 'toolState.list');
          return ctx.toolState.list(toolId);
        },
      } satisfies ToolCliContext['toolState'],
    },
    hostPlanes: {
      value: wrapHostPlanes(tool, allowed, ctx.hostPlanes),
    },
  });

  return bound;
}
