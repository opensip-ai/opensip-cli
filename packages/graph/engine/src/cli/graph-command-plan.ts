/**
 * graph-command-plan — pure execution-shape planner for `opensip graph`.
 *
 * Maps validated options to one of workspace / multi-path / single-path shapes.
 * `executeGraph` delegates here so mode selection stays testable without
 * standing up engines, adapters, or delivery side effects.
 */

import { ConfigurationError } from '@opensip-cli/core';

import { resolvePositionalPaths } from './positional-paths.js';

import type { GraphCommandOptions } from './graph-options.js';

/** High-level run shape after flag validation and positional normalization. */
export type GraphRunShape = 'workspace' | 'multi-path' | 'single-path';

export interface GraphExecutionPlan {
  readonly shape: GraphRunShape;
  /** Normalized positional paths relative to `opts.cwd` (empty for workspace). */
  readonly positionalPaths: readonly string[];
}

/** Reject flag combinations that cannot produce a coherent graph run. */
export function validateGraphCommandFlags(opts: GraphCommandOptions): void {
  if (opts.gateSave === true && opts.gateCompare === true) {
    throw new ConfigurationError('--gate-save and --gate-compare are mutually exclusive.');
  }
  if (opts.workspace === true && (opts.paths?.length ?? 0) > 0) {
    throw new ConfigurationError(
      '--workspace and positional paths are mutually exclusive. Use one or the other.',
    );
  }
  if (opts.workspace === true && (opts.gateSave === true || opts.gateCompare === true)) {
    throw new ConfigurationError(
      '--workspace and --gate-save/--gate-compare are mutually exclusive. ' +
        'Gates and baselines apply to production code; --workspace intentionally scans the full project (including dependencies and test fixtures).',
    );
  }
}

function resolvePositionalScope(opts: GraphCommandOptions): readonly string[] {
  if (!opts.paths || opts.paths.length === 0) return [];
  return resolvePositionalPaths(opts.paths, opts.cwd);
}

/**
 * Plan which execution strategy `executeGraph` should run. Throws
 * {@link ConfigurationError} on invalid flag combinations.
 */
export function planGraphExecution(opts: GraphCommandOptions): GraphExecutionPlan {
  validateGraphCommandFlags(opts);
  const positionalPaths = resolvePositionalScope(opts);
  if (opts.workspace === true) {
    return { shape: 'workspace', positionalPaths: [] };
  }
  if (positionalPaths.length > 1) {
    return { shape: 'multi-path', positionalPaths };
  }
  return { shape: 'single-path', positionalPaths };
}
