/**
 * @fileoverview RunScope — per-invocation execution scope.
 *
 * Owns the lifecycle of every singleton the codebase previously hung on
 * module-level state (logger, caches, registries, recipe-config slot,
 * project context, datastore thunk). Constructed exactly once per CLI
 * invocation; SaaS hosts construct one per concurrent run.
 *
 * Threading happens at the `ToolCliContext` boundary (Phase 5). Tools
 * read `cli.scope.foo` instead of reaching into module globals.
 *
 * AsyncLocalStorage seam: `runWithScope(scope, fn)` binds `scope` as
 * the current scope for the dynamic extent of `fn`. Library functions
 * deep inside the call tree (e.g. fitness's `getCheckConfig(slug)`)
 * read from `currentScope()` instead of `globalThis`. The two-copies-of-
 * fitness hazard documented at the prior `Symbol.for(globalThis)` site
 * is solved by ALS — both fitness copies share the same
 * `AsyncLocalStorage` instance exported from `@opensip-cli/core`.
 */

import { currentScope } from './scope-storage.js';
import { logger as defaultLogger } from './logger.js';

import type { Logger, LoggerImpl } from './logger.js';

export { RunScope, type RunScopeOptions } from './run-scope-class.js';

export {
  runWithScope,
  runWithScopeSync,
  enterScope,
  exitScope,
  currentScope,
} from './scope-storage.js';

/**
 * Read the current run logger, falling back to the compatibility singleton
 * before a RunScope exists. Scoped production code should prefer this helper
 * over importing the singleton logger directly.
 */
export function currentLogger(): Logger {
  return currentScope()?.logger ?? defaultLogger;
}

(defaultLogger as LoggerImpl).setRunIdProvider(() => currentScope()?.runId);