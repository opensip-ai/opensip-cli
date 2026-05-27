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
 * `AsyncLocalStorage` instance exported from `@opensip-tools/core`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { LanguageParseCache } from '../languages/parse-cache.js';
import { defaultLanguageRegistry } from '../languages/registry.js';
import { defaultToolRegistry } from '../tools/registry.js';

import { logger as defaultLogger } from './logger.js';

import type { Logger } from './logger.js';
import type { ProjectContext } from './project-context.js';
import type { LanguageRegistry } from '../languages/registry.js';
import type { ToolRegistry } from '../tools/registry.js';

/** Opaque slot for per-run recipe configuration (replaces globalThis Symbol). */
export interface RecipeCheckConfigSlot {
  get<T extends Record<string, unknown>>(slug: string): T | undefined;
  set(slug: string, config: Record<string, unknown>): void;
  setAll(config: Record<string, Record<string, unknown>>): void;
  clear(): void;
}

class DefaultRecipeCheckConfigSlot implements RecipeCheckConfigSlot {
  private store: Record<string, Record<string, unknown>> = {};

  get<T extends Record<string, unknown>>(slug: string): T | undefined {
    return this.store[slug] as T | undefined;
  }

  set(slug: string, config: Record<string, unknown>): void {
    this.store[slug] = config;
  }

  setAll(config: Record<string, Record<string, unknown>>): void {
    this.store = { ...config };
  }

  clear(): void {
    this.store = {};
  }
}

/** Opaque accessor that lazily opens the datastore on first read. */
export type DataStoreThunk = () => unknown;

export interface RunScopeOptions {
  readonly logger?: Logger;
  readonly parseCache?: LanguageParseCache;
  readonly projectContext?: ProjectContext;
  readonly datastore?: DataStoreThunk;
  readonly tools?: ToolRegistry;
  readonly languages?: LanguageRegistry;
}

/**
 * Per-invocation execution scope.
 *
 * Construct exactly once per CLI invocation. Pass via
 * `ToolCliContext.scope` (Phase 5). Tools read `cli.scope.foo`
 * instead of reaching into module globals (the T1 invariant).
 *
 * Defaults preserve back-compat: when no overrides are provided, the
 * scope wires up the existing `defaultLogger`, a fresh
 * `LanguageParseCache`, `defaultToolRegistry`, and
 * `defaultLanguageRegistry`. This lets the CLI bootstrap migrate
 * incrementally: construct a scope, the tools that haven't been
 * updated yet still see the same module-global registries through
 * the scope's defaults.
 */
export class RunScope {
  readonly logger: Logger;
  readonly parseCache: LanguageParseCache;
  readonly recipeCheckConfig: RecipeCheckConfigSlot;
  readonly projectContext: ProjectContext | undefined;
  readonly datastore: DataStoreThunk;
  readonly tools: ToolRegistry;
  readonly languages: LanguageRegistry;

  constructor(opts: RunScopeOptions = {}) {
    this.logger = opts.logger ?? defaultLogger;
    this.parseCache = opts.parseCache ?? new LanguageParseCache();
    this.recipeCheckConfig = new DefaultRecipeCheckConfigSlot();
    this.projectContext = opts.projectContext;
    this.datastore =
      opts.datastore ??
      (() => {
        throw new Error('RunScope.datastore accessed without a configured thunk.');
      });
    this.tools = opts.tools ?? defaultToolRegistry;
    this.languages = opts.languages ?? defaultLanguageRegistry;
  }

  /** Release per-run resources (caches, recipe-config slot). */
  dispose(): void {
    this.parseCache.dispose();
    this.recipeCheckConfig.clear();
    // FileCache lifecycle is owned by fitness; not on RunScope.
    // datastore close is the consumer's responsibility — RunScope
    // doesn't open it eagerly.
  }
}

// ─── AsyncLocalStorage seam ──────────────────────────────────────────
//
// `runWithScope(scope, fn)` binds `scope` for the dynamic extent of
// `fn`. Library functions read `currentScope()` instead of any
// module global.
//
// Both copies of a package import the same `AsyncLocalStorage`
// instance from this module — so the slot identity is bound to core,
// not to whichever package is reading from it. This solves the
// two-copies-of-fitness hazard documented at the prior
// `Symbol.for(globalThis)` site.

const scopeStorage = new AsyncLocalStorage<RunScope>();

/** Run `fn` with `scope` bound as the current scope for everything in its dynamic extent. */
export function runWithScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run(scope, fn);
}

/** Synchronous variant of `runWithScope`. */
export function runWithScopeSync<T>(scope: RunScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** Read the current scope. Returns undefined when called outside a runWithScope. */
export function currentScope(): RunScope | undefined {
  return scopeStorage.getStore();
}
