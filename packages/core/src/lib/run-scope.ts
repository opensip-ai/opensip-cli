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

import { AsyncLocalStorage } from 'node:async_hooks';

import { LanguageParseCache } from '../languages/parse-cache-class.js';
import { LanguageRegistry } from '../languages/registry.js';
import { noopSignalSink } from '../signals/signal-sink.js';
import { ToolRegistry } from '../tools/registry.js';

import { DiagnosticsBus } from './diagnostics-bus.js';
import { logger as defaultLogger } from './logger.js';

import type { Logger, LoggerImpl } from './logger.js';
import type { ProjectContext } from './project-context.js';
import type { DataStoreThunk, RecipeUnitConfigSlot, ToolScope } from './scope-types.js';
import type { UiContext } from './ui-context.js';
import type { SignalSink } from '../signals/signal-sink.js';

// RecipeUnitConfigSlot, DataStoreThunk, ToolScope, and ScopeContribution
// live in the leaf `scope-types.ts` (audit 2026-05-29, M4) so the `Tool`
// contract can depend on them without naming the concrete `RunScope` —
// breaking the RunScope⟷Tool type cycle. The core barrel sources them
// directly from `scope-types.ts`; `run-scope.ts` imports what it needs below.

class DefaultRecipeUnitConfigSlot implements RecipeUnitConfigSlot {
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

/** Constructor input for {@link RunScope}: registries, services, and per-run identifiers. */
export interface RunScopeOptions {
  readonly logger?: Logger;
  readonly parseCache?: LanguageParseCache;
  readonly projectContext?: ProjectContext;
  readonly datastore?: DataStoreThunk;
  readonly tools?: ToolRegistry;
  readonly languages?: LanguageRegistry;
  /**
   * Per-invocation presentation settings (banner size, CLI version) read
   * by the render paths. Optional: tests and non-rendering callers omit it,
   * in which case `RunScope.ui` is `undefined` and render sites apply their
   * own defaults (banner → `lg`, version → empty).
   */
  readonly ui?: UiContext;
  /**
   * Correlation id for the current CLI invocation. D7 designates this a
   * KERNEL concern (every invocation has one) — it stays flat on the
   * scope rather than under a tool subnamespace. The CLI bootstrap
   * generates it via `generatePrefixedId('run')` and passes it here;
   * the logger reads it back via `currentScope()?.runId` for
   * event-stamping. Optional in `RunScopeOptions` (tests can construct
   * a bare scope) but if omitted, `RunScope.runId` is the empty string
   * — matching the prior logger-singleton reset value used in
   * `configureLogger({ runId: '' })`. Production paths always supply
   * a non-empty id via the pre-action-hook.
   */
  readonly runId?: string;
  /**
   * Cloud signal sink for this invocation (ADR-0008). Defaults to
   * `noopSignalSink` — the CLI bootstrap sets the OpenSIP Cloud sink only
   * when an API key resolves and entitlement is positive. No module-level
   * state: selection is always explicit at the composition root.
   */
  readonly signalSink?: SignalSink;
}

/**
 * Per-invocation execution scope.
 *
 * Construct exactly once per CLI invocation. Pass via
 * `ToolCliContext.scope` (Phase 5). Tools read `cli.scope.foo`
 * instead of reaching into module globals (the T1 invariant).
 *
 * Defaults: when no overrides are provided, the scope wires up the
 * default `Logger`, a fresh `LanguageParseCache`, and FRESH empty
 * `ToolRegistry` / `LanguageRegistry` instances. The CLI bootstrap
 * constructs and populates one pair per run and passes them in via
 * `RunScopeOptions` so language adapters and tool plugins land where
 * `currentScope()?.languages` / `.tools` will find them. Tests that
 * exercise registry-aware code paths must either construct a populated
 * registry and pass it in, or register fixtures into `scope.languages`
 * inside the test body's `runWithScope` block.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional: the class merges with the `interface RunScope extends ToolScope` below to gain the augmentable ScopeContribution slots for reading. The slots are optional and runtime-installed via Object.assign (the kernel's contributeScope loop), so the "interface declares members the class lacks" warning is the desired, safe behavior here.
export class RunScope {
  readonly logger: Logger;
  readonly parseCache: LanguageParseCache;
  readonly recipeUnitConfig: RecipeUnitConfigSlot;
  readonly projectContext: ProjectContext | undefined;
  readonly datastore: DataStoreThunk;
  readonly tools: ToolRegistry;
  readonly languages: LanguageRegistry;
  /** Per-invocation presentation settings; `undefined` outside the CLI render path. */
  readonly ui: UiContext | undefined;
  /**
   * Correlation id for the current invocation. Read by the logger via
   * `currentScope()?.runId` for event-stamping. Empty string when no
   * caller supplied one (matches the prior singleton reset semantics —
   * the logger's `formatEntry` only emits a `runId` field when truthy).
   */
  readonly runId: string;
  /** Cloud signal sink for this invocation; `noopSignalSink` unless cloud sync is on. */
  readonly signalSink: SignalSink;
  /**
   * Per-invocation diagnostics collector (north-star §5.10, release 2.12.0).
   * Library code emits lifecycle events via `currentScope()?.diagnostics`; the
   * host assembler snapshots it onto every `CommandOutcome`. Scope-owned so
   * concurrent runs share no diagnostics state (the no-module-singleton rule).
   */
  readonly diagnostics: DiagnosticsBus;

  constructor(opts: RunScopeOptions = {}) {
    this.logger = opts.logger ?? defaultLogger;
    this.parseCache = opts.parseCache ?? new LanguageParseCache();
    this.recipeUnitConfig = new DefaultRecipeUnitConfigSlot();
    this.projectContext = opts.projectContext;
    // eslint-disable-next-line unicorn/no-useless-undefined -- explicit no-store sentinel matches the prior `cli.datastore` contract (tools cast to `DataStore | undefined`).
    this.datastore = opts.datastore ?? (() => undefined);
    this.tools = opts.tools ?? new ToolRegistry();
    this.languages = opts.languages ?? new LanguageRegistry();
    this.ui = opts.ui;
    this.runId = opts.runId ?? '';
    this.signalSink = opts.signalSink ?? noopSignalSink;
    this.diagnostics = new DiagnosticsBus(this.runId);
  }

  /** Release per-run resources (caches, recipe-config slot). */
  dispose(): void {
    this.parseCache.dispose();
    this.recipeUnitConfig.clear();
    // FileCache lifecycle is owned by fitness; not on RunScope.
    // datastore close is the consumer's responsibility — RunScope
    // doesn't open it eagerly.
  }
}

/**
 * Declaration-merge: `RunScope` IS-A `ToolScope` (the Tool-facing view)
 * plus the `tools` registry it adds. Extending `ToolScope` here also
 * brings in the augmentable `ScopeContribution` slots, so
 * `currentScope()?.simulation` / `?.graph` stay readable on a RunScope.
 * Tools augment `ScopeContribution` (not `RunScope`) from their own
 * packages; the slots flow in through `ToolScope extends ScopeContribution`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- merge target: gives the RunScope class the ToolScope + augmentable ScopeContribution members for reads (e.g. `currentScope()?.graph`). Empty body is intentional — members arrive via ToolScope/ScopeContribution.
export interface RunScope extends ToolScope {}

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

/**
 * Set `scope` as the current scope for the rest of the calling async
 * context — without needing a callback wrapper. Backed by
 * `AsyncLocalStorage.enterWith`. Use this in Commander's `preAction`
 * hook where the action body runs after the hook returns but in the
 * same async chain: `enterWith` propagates the scope forward without
 * needing to wrap the action invocation, which Commander does not let
 * us do directly. Throws on misuse: an existing scope must NOT be
 * replaced silently (call `runWithScope` for nested scopes).
 */
export function enterScope(scope: RunScope): void {
  scopeStorage.enterWith(scope);
}

/** Read the current scope. Returns undefined when called outside a runWithScope. */
export function currentScope(): RunScope | undefined {
  return scopeStorage.getStore();
}

// ─── Logger ↔ RunScope wiring ────────────────────────────────────────
//
// Inject `currentScope()?.runId` as the logger singleton's runId source
// at module init. The logger module itself cannot import from this file
// (run-scope already imports logger, so the reverse direction would
// produce a cycle that depcruise rejects). The wiring lives here, where
// both symbols are already in scope.
//
// `defaultLogger` is typed as `Logger` (a narrow interface) so we
// type-assert to `LoggerImpl` to reach the `setRunIdProvider` setter —
// the singleton is always a `LoggerImpl` (see logger.ts), so this is
// a structural narrowing, not a behavioural cast.
(defaultLogger as LoggerImpl).setRunIdProvider(() => currentScope()?.runId);
