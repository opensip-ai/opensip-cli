/**
 * @fileoverview RunScope augmentation for fitness.
 *
 * D7 (tool subscopes via module augmentation, per the RunScope/
 * Registry architecture): tool-specific concerns nest under the tool's
 * name on `RunScope` and are added via TypeScript module augmentation
 * from the tool's own package. Core never imports fitness-shaped types —
 * the layer rule stays intact (`core ← contracts ← {fitness, ...}`).
 *
 * Two singletons used to hang off this package as module-level state:
 *
 *   - `defaultRegistry`       — per-process check registry.
 *   - `defaultRecipeRegistry` — per-process recipe registry.
 *
 * plus the per-process `ensureChecksLoaded` lifecycle state (the
 * `checksLoadedFor` / `pluginLoadErrors` / `loadWarnings` triple).
 *
 * All of it is now per-RunScope. The fitness tool's `contributeScope`
 * hook (in `tool.ts`) instantiates fresh registries + a fresh `load`
 * marker and attaches them to `scope.fitness` once per CLI invocation.
 * Tools and library code read via
 * `currentScope()?.fitness?.{checks,recipes,load}`.
 *
 * The `fitness` slot is intentionally optional and mutable (no
 * `readonly`) on the augmented interface: the kernel doesn't construct
 * it, and only the fitness tool's `contributeScope` writes to it during
 * scope construction. A run that doesn't load the fitness tool carries
 * no `scope.fitness`, and reads return `undefined`.
 */

import type { FileCache } from './framework/file-cache.js';
import type { CheckRegistry } from './framework/registry.js';
import type { FitnessRecipeRegistry } from './recipes/registry.js';
import type { CliDiagnostic } from '@opensip-cli/core';

/**
 * Per-RunScope `ensureChecksLoaded` lifecycle state — moved off the
 * `check-loader.ts` module singletons so two concurrent scopes carry
 * independent load state. Mutable: `ensureChecksLoaded` writes it once
 * per run; the phase helpers (`buildFitEnvelope`, `buildFitPresentation`)
 * and the public accessors read it back.
 */
export interface FitnessLoadState {
  /** Project directory for which `ensureChecksLoaded` has run to
   *  completion in THIS scope. `null` before the first load; `''` is the
   *  "loaded" sentinel for the no-project case. */
  loadedFor: string | null;
  /** Plugin load failures from the most recent `ensureChecksLoaded` call. */
  pluginLoadErrors: readonly string[];
  /** Fit-pack domain load/routing errors from the most recent load. */
  checkPackErrors: readonly string[];
  /** Non-fatal user-facing warnings collected during the most recent
   *  `ensureChecksLoaded` call. */
  loadWarnings: string[];
  /** Fail-closed command-error diagnostic when setup prevents a credible scan. */
  commandError?: CliDiagnostic;
  /** Optional-only failures while built-in checks still loaded (strict degraded). */
  loadDegraded?: boolean;
  /** Typed diagnostics for optional failures surfaced as degraded warnings. */
  degradedDiagnostics: readonly CliDiagnostic[];
  /** Guards `finalizeFitLoadOutcome` idempotency per run. */
  outcomeFinalized?: boolean;
}

/**
 * Per-run holder for the shared, lazily-built type-checked TypeScript Program
 * (D2). A single `ts.Program` + bound `TypeChecker` is expensive (~1s / ~0.6 GB
 * on a ~900-file corpus) but type-aware checks need it, so it is built ONCE per
 * run and reused by every type-aware TS check, then released on dispose.
 *
 * `value` is intentionally `unknown`: the build logic lives in
 * `@opensip-cli/checks-typescript` (which owns the `lang-typescript`/`typescript`
 * runtime dep), so the fitness engine and core never name lang-typescript's
 * `TypeCheckedProgram` — keeping the heavy `typescript` dep out of the engine
 * and every non-TS check run. The TS pack casts `value` to its concrete type.
 */
export interface SharedTsProgramCell {
  value: unknown;
}

/**
 * Per-RunScope fitness state. Constructed by the fitness tool's
 * `contributeScope()` hook and attached to `scope.fitness`.
 */
export interface FitnessSubscope {
  /** Check registry — populated by `loadAllPlugins` /
   *  `loadDiscoveredCheckPackages` during `ensureChecksLoaded`. */
  readonly checks: CheckRegistry;
  /** Recipe registry — seeded with built-in recipes at construction;
   *  plugin loader registers user recipes. */
  readonly recipes: FitnessRecipeRegistry;
  /** `ensureChecksLoaded` lifecycle state for this run. */
  readonly load: FitnessLoadState;
  /** Per-run file cache — prewarmed by the recipe service, read by every
   *  reader site (execution context, file accessor, ignore processing),
   *  cleared on scope dispose via the disposer `contributeScope` returns.
   *  Replaces the module singleton on every production path. */
  readonly fileCache: FileCache;
  /** Lazily-built shared type-checked TS Program for this run (D2). Built by
   *  checks-typescript's `getSharedTypeCheckedProgram` on the first type-aware
   *  check, reused by all, and cleared by the dispose hook. */
  readonly tsProgram: SharedTsProgramCell;
}

declare module '@opensip-cli/core' {
  interface ScopeContribution {
    /**
     * Fitness tool's per-run state. Returned by the fitness tool's
     * `contributeScope` hook and installed by the kernel; absent in runs
     * where the fitness tool is not registered. Consumers MUST null-check
     * before reading. Augments `ScopeContribution`, which
     * `ToolScope`/`RunScope` extend — so `cli.scope.fitness` /
     * `currentScope()?.fitness` stay readable.
     */
    fitness?: FitnessSubscope;
  }
}
