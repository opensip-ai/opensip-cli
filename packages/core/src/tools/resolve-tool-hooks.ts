/**
 * Resolve lifecycle hooks from a {@link Tool}'s `extensionPoints` bag and any
 * legacy top-level fields. Top-level wins when both are set (compat during
 * migration); new tools should use `extensionPoints` only via {@link defineTool}.
 */

import type { CapabilityRegistrar, ToolConfigContribution } from './capability.js';
import type { ScaffoldContext, ScaffoldFile } from './scaffold.js';
import type { Tool, ToolSessionReplayContribution } from './types.js';
import type { FingerprintStrategy } from '../baseline/fingerprint-strategy.js';
import type { RunScope } from '../lib/run-scope.js';
import type { ScopeContribution, ToolScope } from '../lib/scope-types.js';

/** Every optional hook the host reads, resolved to a single object. */
export interface ResolvedToolHooks {
  readonly initialize?: () => Promise<void>;
  readonly contributeScope?: () => ScopeContribution;
  readonly collectReportData?: (
    scope: ToolScope,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  readonly sessionReplay?: ToolSessionReplayContribution;
  readonly config?: ToolConfigContribution;
  readonly capabilityRegistrars?: Readonly<Record<string, CapabilityRegistrar>>;
  readonly fingerprintStrategy?: FingerprintStrategy;
  readonly scaffoldExamples?: (ctx: ScaffoldContext) => readonly ScaffoldFile[];
  readonly stableExampleIds?: () => readonly string[];
  readonly scaffoldConfigBlock?: () => string;
}

/**
 * Merge `tool.extensionPoints` with legacy top-level hook fields.
 * Host code should read hooks exclusively through this resolver.
 */
export function resolveToolHooks(tool: Tool): ResolvedToolHooks {
  const bag = tool.extensionPoints;
  return {
    initialize: tool.initialize ?? bag?.initialize,
    contributeScope: tool.contributeScope ?? bag?.contributeScope,
    collectReportData: tool.collectReportData ?? bag?.collectReportData,
    sessionReplay: tool.sessionReplay ?? bag?.sessionReplay,
    config: tool.config ?? bag?.config,
    capabilityRegistrars: tool.capabilityRegistrars ?? bag?.capabilityRegistrars,
    fingerprintStrategy: tool.fingerprintStrategy ?? bag?.fingerprintStrategy,
    scaffoldExamples: tool.scaffoldExamples ?? bag?.scaffoldExamples,
    stableExampleIds: tool.stableExampleIds ?? bag?.stableExampleIds,
    scaffoldConfigBlock: tool.scaffoldConfigBlock ?? bag?.scaffoldConfigBlock,
  };
}

/**
 * Install a tool's `contributeScope` contribution onto a {@link RunScope}.
 * Tests and tooling should use this instead of reading top-level hooks directly.
 */
export function applyToolContributeScope(scope: RunScope, tool: Tool): void {
  const contribution = resolveToolHooks(tool).contributeScope?.();
  if (contribution) {
    Object.assign(scope, contribution);
  }
}
