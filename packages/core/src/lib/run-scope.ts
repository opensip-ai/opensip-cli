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
import { SystemError } from './errors.js';
import { logger as defaultLogger } from './logger.js';

import type { Logger, LoggerImpl } from './logger.js';
import type { ProjectContext } from './project-context.js';
import type { RunCorrelation } from './run-correlation.js';
import type { DataStoreThunk, RecipeUnitConfigSlot, ToolScope } from './scope-types.js';
import type { UiContext } from './ui-context.js';
import type { SignalSink } from '../signals/signal-sink.js';
import type { ToolPluginManifest, ToolProvenance } from '../tools/manifest.js';

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
  /**
   * The manifests of the tools admitted through the compatibility gate this
   * run, in registration order. Recorded by the CLI bootstrap and stamped on
   * the scope so host commands (`tools list`) read them via `currentScope()`
   * instead of a module global. Defaults to `[]` (no tools admitted — e.g. an
   * isolated test scope). HOST-only: tools never read these, so they live on
   * `RunScope`, not the tool-facing `ToolScope`.
   */
  readonly toolManifests?: readonly ToolPluginManifest[];
  /**
   * The provenance records of the tools admitted this run (source, identity,
   * manifest hash), paired index-wise with {@link toolManifests}. Recorded by
   * the CLI bootstrap and stamped on the scope so host commands (`plugin list`,
   * `tools list`, `tools uninstall`) read them via `currentScope()` rather than
   * a module global. Defaults to `[]`.
   */
  readonly toolProvenance?: readonly ToolProvenance[];
  /**
   * Generic per-run telemetry scratch space. Core owns the bag lifecycle, while
   * CLI telemetry modules own any implementation-specific values they place in
   * it. This keeps optional SDK/profiler state off module globals without
   * making core import telemetry implementations.
   */
  readonly telemetry?: Record<string, unknown>;
  /**
   * Cloud-aware correlation bag for this invocation (subprocess-correlation
   * spec, B2). Assembled at the bootstrap composition root
   * (`build-per-run-scope.ts`) from the resolved cloud config — the one place
   * the resolved cloud identity is in hand. Core stays a kernel: it carries the
   * pure {@link RunCorrelation} type but never resolves cloud config. Library
   * code deep in the call tree reads it via `currentScope()?.correlation` and
   * forwards it into spawned/forked children via `correlationToEnv`. Optional:
   * tests and bare scopes omit it (`RunScope.correlation` is then `undefined`).
   */
  readonly correlation?: RunCorrelation;
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
   * Per-invocation diagnostics collector (north-star §5.10, launch).
   * Library code emits lifecycle events via `currentScope()?.diagnostics`; the
   * host assembler snapshots it onto every `CommandOutcome`. Scope-owned so
   * concurrent runs share no diagnostics state (the no-module-singleton rule).
   */
  readonly diagnostics: DiagnosticsBus;
  /**
   * Manifests of the tools admitted this run (registration order). Empty unless
   * the CLI bootstrap recorded them. Read by host commands via `currentScope()`.
   */
  readonly toolManifests: readonly ToolPluginManifest[];
  /**
   * Provenance of the tools admitted this run, paired index-wise with
   * {@link toolManifests}. Empty unless the CLI bootstrap recorded them.
   */
  readonly toolProvenance: readonly ToolProvenance[];
  /** Per-run telemetry scratch space; see {@link RunScopeOptions.telemetry}. */
  readonly telemetry: Record<string, unknown>;
  /**
   * Cloud-aware correlation bag for this invocation (B2). Assembled once at the
   * bootstrap composition root and read by library code via
   * `currentScope()?.correlation`; `undefined` when no caller supplied one
   * (tests / bare scopes). See {@link RunScopeOptions.correlation}.
   */
  readonly correlation: RunCorrelation | undefined;

  /**
   * Tool-registered teardown callbacks, invoked once during {@link dispose}.
   * Tool-agnostic: a tool releases per-run resources it owns (e.g. fitness
   * clears its `FileCache` + the auto-clear timer) via {@link onDispose}
   * WITHOUT core importing any tool type — keeping `dispose()` tool-agnostic
   * and the layer rule (`core ← contracts ← {fitness,...}`) intact.
   */
  private readonly disposers: (() => void)[] = [];

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
    this.toolManifests = opts.toolManifests ?? [];
    this.toolProvenance = opts.toolProvenance ?? [];
    this.telemetry = opts.telemetry ?? {};
    // No default: `undefined` when no caller supplies one (the test/bare-scope
    // contract). Production paths assemble it at the composition root (B2).
    this.correlation = opts.correlation;
  }

  /**
   * Register a callback invoked once during {@link dispose}. Tools use this
   * to release per-run resources they own (e.g. fitness clears its `FileCache`
   * + auto-clear timer) WITHOUT core importing any tool type — keeps
   * `dispose()` tool-agnostic and the layer rule intact. Registered by the
   * kernel install seam from the disposer a tool RETURNS via `contributeScope`
   * (the {@link ScopeContributionWithDisposer} wrapper); the recipe service
   * additionally registers one on ad-hoc scopes that carry no fitness subscope.
   * Idempotent dispose: callbacks run at most once; `dispose()` clears the list.
   */
  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** Release per-run resources (caches, recipe-config slot, tool disposers). */
  dispose(): void {
    this.parseCache.dispose();
    this.recipeUnitConfig.clear();
    // Run every tool-registered disposer (e.g. fitness clears its FileCache +
    // the auto-clear timer). Defensive: a throwing disposer must not skip the
    // rest or the parse-cache/recipe-config cleanup above. `splice(0)` empties
    // the list so dispose() is idempotent (each callback runs at most once).
    for (const fn of this.disposers.splice(0)) {
      try {
        fn();
      } catch {
        /* @swallow-ok a disposer failure must not abort teardown */
      }
    }
    // datastore close is the consumer's responsibility — RunScope doesn't open
    // it eagerly. The CLI bootstrap registers the datastore thunk's `dispose`
    // via onDispose, so a connection opened this run IS closed by the loop above.
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
// The ALS instance is pinned on `globalThis` so duplicate physical copies
// of `@opensip-cli/core` (pnpm `injectWorkspacePackages` hard-links fitness
// into the virtual store with its own nested core copy) still share one
// scope slot. A module-level `new AsyncLocalStorage()` would split the
// store across those copies and silently degrade content filters.
//
// Concurrency contract — two ways to bind a scope, with strict roles:
//
//   • `runWithScope(scope, fn)` / `runWithScopeSync(scope, fn)` —
//     bind `scope` for the dynamic extent of `fn` via
//     `AsyncLocalStorage.run`. This is the ONLY safe way to bind a
//     scope for concurrent or nested in-process work: each task's
//     scope is isolated to its own `fn`, runs nest cleanly, and two
//     overlapping runs never collide on the shared slot. SaaS hosts
//     and any in-process parallelism MUST use this.
//
//   • `enterScope(scope)` — the Commander single-command path ONLY:
//     one entry per CLI invocation, in the pre-action hook. It mutates
//     the single ALS slot (`enterWith`) for the rest of the async
//     context, so it is unsafe for concurrent or nested work. NEVER
//     call `enterScope` while another scope task is in flight; the
//     always-on guard throws `SYSTEM.SCOPE.REENTRANT` if a *different*
//     scope is already current.
//
// Per-run log isolation rides on the same seam: distinct scopes carry
// distinct `runId`s, and the logger reads `currentScope()?.runId`
// (wired below via `setRunIdProvider`), so concurrent runs produce
// non-colliding, per-run-filterable logs.

const SCOPE_STORAGE_KEY = Symbol.for('@opensip-cli/core/scopeStorage');

/** Process-global ALS singleton — survives duplicate @opensip-cli/core copies. */
function scopeStorage(): AsyncLocalStorage<RunScope> {
  const slot = globalThis as {
    [SCOPE_STORAGE_KEY]?: AsyncLocalStorage<RunScope>;
  };
  slot[SCOPE_STORAGE_KEY] ??= new AsyncLocalStorage<RunScope>();
  return slot[SCOPE_STORAGE_KEY];
}

/**
 * Run `fn` with `scope` bound as the current scope for everything in its
 * dynamic extent. Backed by `AsyncLocalStorage.run`, so it nests cleanly
 * and is the concurrency-safe binding: use this (never a shared
 * {@link enterScope}) for concurrent or nested in-process work — two
 * overlapping runs each see their own scope and never collide.
 */
export function runWithScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return scopeStorage().run(scope, fn);
}

/** Synchronous variant of `runWithScope`. */
export function runWithScopeSync<T>(scope: RunScope, fn: () => T): T {
  return scopeStorage().run(scope, fn);
}

/**
 * Set `scope` as the current scope for the rest of the calling async
 * context — without needing a callback wrapper. Backed by
 * `AsyncLocalStorage.enterWith`. Use this in Commander's `preAction`
 * hook where the action body runs after the hook returns but in the
 * same async chain: `enterWith` propagates the scope forward without
 * needing to wrap the action invocation, which Commander does not let
 * us do directly.
 *
 * `enterScope` is the **Commander single-command path only** — exactly
 * one entry per CLI invocation, in the pre-action hook. It mutates the
 * single ALS slot for the rest of the async context, so it is unsafe for
 * concurrent or nested work.
 *
 * Always-on re-entrancy guard: throws `SystemError`
 * (`SYSTEM.SCOPE.REENTRANT`) if a *different* scope is already current.
 * Re-entering the **same** scope (idempotent — e.g. a retried pre-action
 * path) is a no-op and does NOT throw; entering when **none** is current
 * (the normal single-command path) is allowed. For concurrent or nested
 * scopes use {@link runWithScope}/{@link runWithScopeSync}, which bind via
 * `AsyncLocalStorage.run` and nest cleanly without touching the shared slot.
 */
export function enterScope(scope: RunScope): void {
  const current = scopeStorage().getStore();
  if (current !== undefined && current !== scope) {
    throw new SystemError(
      'enterScope called while a different scope is already current. ' +
        'Concurrent or nested work must use runWithScope(scope, fn), not a shared enterScope.',
      { code: 'SYSTEM.SCOPE.REENTRANT' },
    );
  }
  scopeStorage().enterWith(scope);
}

/**
 * Clear the ambient scope slot — the symmetric counterpart to {@link enterScope}.
 * Backed by `AsyncLocalStorage.enterWith(undefined)`, so it resets the single ALS
 * slot for the rest of the calling async context.
 *
 * Host-only, single-command path: the Commander `postAction` hook calls this after
 * disposing the entered scope, completing the per-command lifecycle (enter in
 * `preAction` → dispose + exit in `postAction`). Clearing the slot leaves a clean
 * ALS state for any *subsequent* command run in the same process — so a long-lived
 * host that drives Commander sequentially (or a test that parses twice) does not
 * trip the always-on re-entrancy guard on the next `enterScope`. A no-op when no
 * scope is current. Concurrent/nested work never needs this — {@link runWithScope}
 * restores the prior slot on its own when its `fn` returns.
 */
export function exitScope(): void {
  // `enterWith(undefined)` clears the slot for this async context. The storage
  // is typed `AsyncLocalStorage<RunScope>` so `getStore()` stays non-nullable at
  // read sites; the cast is the one place we exercise the runtime's documented
  // "store may be undefined" contract to reset the slot.
  // eslint-disable-next-line unicorn/no-useless-undefined -- the `undefined` is load-bearing: it is the slot-clear value for AsyncLocalStorage.enterWith, not a removable default.
  (scopeStorage() as AsyncLocalStorage<RunScope | undefined>).enterWith(undefined);
}

/** Read the current scope. Returns undefined when called outside a runWithScope. */
export function currentScope(): RunScope | undefined {
  return scopeStorage().getStore();
}

/**
 * Read the current run logger, falling back to the compatibility singleton
 * before a RunScope exists. Scoped production code should prefer this helper
 * over importing the singleton logger directly.
 */
export function currentLogger(): Logger {
  return currentScope()?.logger ?? defaultLogger;
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
