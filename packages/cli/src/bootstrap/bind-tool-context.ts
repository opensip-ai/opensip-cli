/**
 * bind-tool-context — mount-time guard for tool-scoped host planes.
 *
 * The host-owned baseline, toolState, governance, audit, and entitlement planes
 * are all keyed by a `tool` string for backward compatibility with the public
 * ToolCliContext. The mounted command already has an owning Tool, so bind that
 * ownership into a thin context wrapper and reject accidental or malicious
 * cross-tool keys before they reach persistence.
 */

import {
  PluginIncompatibleError,
  resolveToolCommands,
  resolveToolHooks,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';

type BoundToolCliContext = ToolCliContext;

function primaryCommandName(tool: Tool): string | undefined {
  const commands = resolveToolCommands(tool);
  return tool.commandSpecs?.[0]?.name ?? commands[0]?.name;
}

export function toolOwnedKeys(tool: Tool): ReadonlySet<string> {
  return new Set(
    [
      tool.metadata.id,
      tool.metadata.name,
      primaryCommandName(tool),
      resolveToolHooks(tool).sessionReplay?.tool,
      resolveToolHooks(tool).config?.namespace,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
}

function describeTool(tool: Tool): string {
  return tool.metadata.name || tool.metadata.id;
}

/**
 * @throws {PluginIncompatibleError} When a mounted tool attempts to use a
 * host-owned seam with another tool's namespace.
 */
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
  const wrapped: NonNullable<ToolCliContext['hostPlanes']> = {};
  const governance = hostPlanes.governance;
  if (governance !== undefined) {
    wrapped.governance = {
      getGovernanceState: (toolId) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.getGovernanceState');
        return governance.getGovernanceState(toolId);
      },
      listForProject: governance.listForProject.bind(governance),
      queryAudit: (toolId, filter) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.queryAudit');
        return governance.queryAudit(toolId, filter);
      },
      recordInstallation: (toolId, record) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.recordInstallation');
        return governance.recordInstallation(toolId, record);
      },
      recordApprovalDecision: (toolId, decision) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.recordApprovalDecision');
        return governance.recordApprovalDecision(toolId, decision);
      },
      setBlock: (toolId, blocked, reason) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.setBlock');
        return governance.setBlock(toolId, blocked, reason);
      },
      checkAllowed: (toolId, action) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.governance.checkAllowed');
        return governance.checkAllowed(toolId, action);
      },
    };
  }

  const audit = hostPlanes.audit;
  if (audit !== undefined) {
    wrapped.audit = {
      append: (toolId, entry) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.audit.append');
        return audit.append(toolId, entry);
      },
      query: (toolId, filter) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.audit.query');
        return audit.query(toolId, filter);
      },
      ...(audit.exportForCloud ? { exportForCloud: audit.exportForCloud.bind(audit) } : {}),
    };
  }

  const entitlements = hostPlanes.entitlements;
  if (entitlements !== undefined) {
    wrapped.entitlements = {
      check: (toolId, action) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.check');
        return entitlements.check(toolId, action);
      },
      recordUsage: (toolId, usage) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.recordUsage');
        return entitlements.recordUsage(toolId, usage);
      },
      getLicenseState: (toolId) => {
        assertOwnToolKey(tool, allowed, toolId, 'hostPlanes.entitlements.getLicenseState');
        return entitlements.getLicenseState(toolId);
      },
    };
  }

  return wrapped;
}

export function bindToolCliContext(tool: Tool, ctx: ToolCliContext): BoundToolCliContext {
  const allowed = toolOwnedKeys(tool);
  const source: object = ctx;
  const bound = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(source),
  ) as BoundToolCliContext;

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
