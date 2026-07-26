/**
 * Resolve lifecycle hooks from a {@link Tool}'s `extensionPoints` bag.
 * New tools must use `extensionPoints` only via {@link defineTool}.
 */

import { PluginIncompatibleError } from '../lib/errors.js';
import {
  isContributionWithDisposer,
  type ContributeScopeResult,
  type ScopeContribution,
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

const FORBIDDEN_SCOPE_CONTRIBUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Validate and install a plain {@link ScopeContribution} onto a RunScope.
 * Shared by both bare and disposer-wrapped contribution forms.
 *
 * @throws {PluginIncompatibleError} PLUGIN.SCOPE_CONTRIBUTION_INVALID |
 *   FORBIDDEN_KEY | COLLISION
 */
function installValidatedContribution(
  scope: RunScope,
  tool: Tool,
  contribution: ScopeContribution,
): void {
  if (typeof contribution !== 'object' || contribution === null || Array.isArray(contribution)) {
    throw new PluginIncompatibleError(
      `tool '${tool.metadata.name || tool.metadata.id}' returned a non-object scope contribution`,
      {
        code: 'PLUGIN.SCOPE_CONTRIBUTION.INVALID',
        diagnostic: 'contributeScope must return a plain object',
      },
    );
  }

  for (const key of Object.keys(contribution)) {
    if (FORBIDDEN_SCOPE_CONTRIBUTION_KEYS.has(key)) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' returned forbidden scope key '${key}'`,
        {
          code: 'PLUGIN.SCOPE_CONTRIBUTION.FORBIDDEN_KEY',
          diagnostic: `forbidden scope key '${key}'`,
        },
      );
    }
    // `key in scope` (not own-property) so prototype members like dispose are
    // protected against shadowing.
    if (key in scope) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' attempted to overwrite scope key '${key}'`,
        {
          code: 'PLUGIN.SCOPE_CONTRIBUTION.COLLISION',
          diagnostic: `scope key '${key}' already exists`,
        },
      );
    }
  }

  Object.assign(scope, contribution);
}

/**
 * Install a tool's `contributeScope` contribution onto a {@link RunScope}
 * after validating plain-object shape, forbidden keys, and existing-scope
 * collisions. Tests, tooling, and CLI bootstrap all use this single installer
 * so production and test contribution behavior cannot drift.
 *
 * Supports both bare {@link ScopeContribution} and
 * `{ contribution, onDispose }` forms. The disposer is registered only after
 * successful installation and exactly once.
 *
 * @throws {PluginIncompatibleError} when the contribution is invalid
 */
export function applyToolContributeScope(scope: RunScope, tool: Tool): void {
  const hook = resolveToolHooks(tool).contributeScope;
  if (hook === undefined) return;
  const contribution = hook();
  // Absent hook or explicit `undefined` is a no-op; null/array/primitive fail.
  if (contribution === undefined) return;
  if (typeof contribution !== 'object' || contribution === null) {
    installValidatedContribution(scope, tool, contribution);
    return;
  }

  if (isContributionWithDisposer(contribution)) {
    installValidatedContribution(scope, tool, contribution.contribution);
    if (contribution.onDispose) scope.onDispose(contribution.onDispose);
    return;
  }
  installValidatedContribution(scope, tool, contribution);
}
