/**
 * Resolve lifecycle hooks from a {@link Tool}'s `extensionPoints` bag.
 * New tools must use `extensionPoints` only via {@link defineTool}.
 */

import {
  isContributionWithDisposer,
  type ContributeScopeResult,
  type ToolScope,
} from '../lib/scope-types.js';

import type { CapabilityRegistrar, ToolConfigContribution } from './capability.js';
import type { ScaffoldContext, ScaffoldFile } from './scaffold.js';
import type { Tool, ToolSessionReplayContribution } from './types.js';
import type { FingerprintStrategy } from '../baseline/fingerprint-strategy.js';
import type { RunScope } from '../lib/run-scope.js';

/** Every optional hook the host reads, resolved to a single object. */
export interface ResolvedToolHooks {
  readonly initialize?: () => Promise<void>;
  readonly contributeScope?: () => ContributeScopeResult;
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

/** Read hooks from `tool.extensionPoints`. Host code uses this resolver exclusively. */
export function resolveToolHooks(tool: Tool): ResolvedToolHooks {
  const bag = tool.extensionPoints;
  return {
    initialize: bag?.initialize,
    contributeScope: bag?.contributeScope,
    collectReportData: bag?.collectReportData,
    sessionReplay: bag?.sessionReplay,
    config: bag?.config,
    capabilityRegistrars: bag?.capabilityRegistrars,
    fingerprintStrategy: bag?.fingerprintStrategy,
    scaffoldExamples: bag?.scaffoldExamples,
    stableExampleIds: bag?.stableExampleIds,
    scaffoldConfigBlock: bag?.scaffoldConfigBlock,
  };
}

/**
 * Install a tool's `contributeScope` contribution onto a {@link RunScope}.
 * Tests and tooling should use this instead of reading top-level hooks directly.
 */
export function applyToolContributeScope(scope: RunScope, tool: Tool): void {
  const contribution = resolveToolHooks(tool).contributeScope?.();
  if (contribution) {
    if (isContributionWithDisposer(contribution)) {
      Object.assign(scope, contribution.contribution);
      if (contribution.onDispose) scope.onDispose(contribution.onDispose);
      return;
    }
    Object.assign(scope, contribution);
  }
}
