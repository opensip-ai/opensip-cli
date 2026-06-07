/**
 * @fileoverview Scope type contracts — the leaf module that breaks the
 * `RunScope ⟷ Tool` type cycle (audit 2026-05-29, M4).
 *
 * The cycle was `run-scope.ts → tools/registry.ts → tools/types.ts →
 * run-scope.ts`: `RunScope` holds a `ToolRegistry` (→ `Tool`), and the
 * `Tool` contract named the concrete `RunScope` back (via
 * `ToolCliContext.scope` and the old `extendScope`). Both edges are
 * type-only, so there is no runtime cycle — but it's a kernel smell and
 * was invisible to the architecture gate (`tsPreCompilationDeps:false`).
 *
 * The fix is DIP: the `Tool` contract depends on the abstractions here,
 * never on the concrete `RunScope`. This module imports NOTHING from
 * `tools/` or `run-scope.ts`, so it is a true leaf — `tools/types.ts`
 * can depend on it with no edge back to `run-scope.ts`.
 *
 * - `ToolScope`  — the Tool-FACING view of the scope (everything tools
 *   read via `cli.scope.*`), deliberately WITHOUT the `tools`
 *   `ToolRegistry` (which would re-introduce the `→ Tool` edge). Tools
 *   never read `scope.tools`. `RunScope` is a `ToolScope` plus `tools`.
 * - `ScopeContribution` — the augmentable slot bag a tool returns from
 *   `Tool.contributeScope()`. Tools augment THIS (not `RunScope`); the
 *   kernel `Object.assign`s it onto the scope. `RunScope`/`ToolScope`
 *   inherit the slots for reading.
 */

import type { Logger } from './logger.js';
import type { ProjectContext } from './project-context.js';
import type { LanguageParseCache } from '../languages/parse-cache-class.js';
import type { LanguageRegistry } from '../languages/registry.js';
import type { SignalSink } from '../signals/signal-sink.js';

/** Opaque slot for per-run recipe configuration (replaces globalThis Symbol). */
export interface RecipeUnitConfigSlot {
  get<T extends Record<string, unknown>>(slug: string): T | undefined;
  set(slug: string, config: Record<string, unknown>): void;
  setAll(config: Record<string, Record<string, unknown>>): void;
  clear(): void;
}

/**
 * The resolved, validated tool configuration for this run (release 2.10.0,
 * ADR-0023, Phase 4). `namespace -> { key -> value }`, where each top-level
 * key is a tool's namespace (`graph`/`fitness`/`simulation`) after the host
 * composed every tool's contributed schema, validated the document STRICT,
 * and resolved precedence (flag > env > file > defaults).
 *
 * Structurally identical to `@opensip-tools/config`'s `ResolvedConfig`, kept
 * Zod-free here so the kernel carries no config-layer dependency — the CLI
 * (which DOES import `@opensip-tools/config`) writes it, and tools read their
 * own namespace via `currentScope()?.toolConfig?.<namespace>`.
 */
export type ResolvedToolConfig = Record<string, Record<string, unknown>>;

/**
 * Opaque accessor that lazily opens the datastore on first read.
 * Returns `undefined` when no datastore is configured for this scope.
 */
export type DataStoreThunk = () => unknown;

/**
 * Per-tool subscope contribution. Each tool augments this interface from
 * its own package (`declare module '@opensip-tools/core' { interface
 * ScopeContribution { graph?: … } }`) and returns the matching object
 * from `Tool.contributeScope()`. The kernel installs it onto the scope.
 * `ToolScope` (and therefore `RunScope`) extends this, so the same slots
 * are readable via `cli.scope.<tool>` / `currentScope()?.<tool>`.
 *
 * Empty here by design — every member arrives via tool augmentation, so
 * core never names a tool-specific type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally empty: every member is contributed by a tool via `declare module '@opensip-tools/core' { interface ScopeContribution { … } }`. `object`/`unknown` would not be augmentable.
export interface ScopeContribution {}

/**
 * The Tool-facing view of the per-invocation scope: everything a tool
 * reads through `ToolCliContext.scope`. Excludes the `tools`
 * `ToolRegistry` on purpose — tools never read it, and naming it here
 * would re-introduce the `Tool` reference that creates the cycle.
 * `RunScope` is structurally a `ToolScope` with `tools` added.
 */
export interface ToolScope extends ScopeContribution {
  readonly logger: Logger;
  readonly parseCache: LanguageParseCache;
  readonly recipeUnitConfig: RecipeUnitConfigSlot;
  readonly projectContext: ProjectContext | undefined;
  readonly datastore: DataStoreThunk;
  readonly languages: LanguageRegistry;
  readonly runId: string;
  /** Cloud signal sink for this run (ADR-0008); `noopSignalSink` unless cloud sync is on. */
  readonly signalSink: SignalSink;
  /**
   * The resolved, strict-validated tool configuration for this run (ADR-0023,
   * Phase 4). Seeded by the CLI's pre-action-hook after composing every
   * registered tool's contributed schema and validating the config document;
   * absent on a scope built without a config document (e.g. a project-agnostic
   * command, or a config-less project). A tool reads its own namespace
   * (`scope.toolConfig?.graph`, `?.fitness`, `?.simulation`).
   */
  readonly toolConfig?: ResolvedToolConfig;
}
