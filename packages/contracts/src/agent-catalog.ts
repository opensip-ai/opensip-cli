/**
 * Structured catalog TYPES for AI agents (ADR-0084).
 *
 * The serializable catalog shape (`AgentCatalog`), its builder input
 * (`AgentCatalogBuildInput`), and the taxonomy tier union (`CommandTier`) live
 * here in contracts — the layer below every consumer — so the CLI
 * `agent-catalog` command, `@opensip-cli/mcp`, and third-party tooling name
 * one shape. The catalog CONTENT builder (`buildAgentCatalog`), the curated
 * entry-point/overlay data, and the transport-parity assembler moved to
 * `@opensip-cli/shared-analysis` (Plan 09 Phase 7): contracts stays a frozen
 * type/constant/schema facade with no cross-tool analysis runtime.
 */

import type { AgentHostSupport } from './host-support.js';
import type { AgentProjectContext } from './target-conventions.js';
import type { ToolRegistry } from '@opensip-cli/core';

/**
 * The command-taxonomy tier an entry point belongs to
 * (tool-command-surface-taxonomy). `'platform'` = host-owned Tier-1 commands
 * (`init`, `sessions`, `agent-catalog`, …); `'tool'` = a Tier-2 tool verb
 * (`fit`, `graph`, `sim`, and their `<tool> <verb>` sub-verbs). `'internal'`
 * (Tier-3 workers) is part of the union for completeness ONLY — the agent-catalog
 * NEVER emits an `internal` entry point (its primary surface excludes Tier-3).
 */
export type CommandTier = 'platform' | 'tool' | 'internal';

/**
 * The machine-readable description of opensip-cli's command surface emitted by
 * `opensip agent-catalog` and consumed over MCP. It advertises the public entry
 * points (Tier-1 platform commands + Tier-2 tool verbs), common usage patterns,
 * the shapes a caller gets back, and free-form usage notes — everything an agent
 * needs to drive the CLI without reading its source.
 */
export interface AgentCatalog {
  readonly version: string;
  readonly description: string;
  readonly entryPoints: readonly {
    readonly command: string;
    readonly description: string;
    readonly examples: readonly string[];
    /**
     * Taxonomy tier of this entry point (tool-command-surface-taxonomy). Additive
     * (optional) so existing consumers of the `entryPoints` shape are unaffected;
     * present on every entry the catalog ships so an agent sees the predictable
     * Tier-1/Tier-2 structure. NEVER `'internal'` — Tier-3 is excluded from this
     * surface by construction (the builder in @opensip-cli/shared-analysis
     * asserts no internal entry point leaks).
     */
    readonly tier?: CommandTier;
  }[];
  readonly commonPatterns: readonly {
    readonly name: string;
    readonly description: string;
    readonly example: string;
  }[];
  readonly outputShapes: {
    readonly signalEnvelope: string; // high-level note + reference
    readonly reviewBrief: string;
    readonly taskContext: string;
    readonly repairApplyVerify: string;
    readonly sessionReplay: string;
    readonly history: string;
  };
  readonly projectContext?: AgentProjectContext;
  /**
   * Names no Tool or configured suite may claim (ADR-0159). Additive
   * (optional): the composition root injects the live lists (it owns them —
   * this contracts layer cannot import the cli or config packages), so
   * bare contracts builds may omit the field. The production CLI and MCP
   * composition roots both provide it through the shared assembler.
   * `rootCommands` = host-owned root commands a Tool cannot mount;
   * `suiteNames` = built-in suite names a configured suite cannot use.
   */
  readonly reservedNames?: {
    readonly rootCommands: readonly string[];
    readonly suiteNames: readonly string[];
  };
  /**
   * Honest, process-only host-support projection (Plan 02, macOS GA). Additive
   * (optional): the composition root observes the live process, asks core to
   * classify it, and injects the serializable projection here. Catalogs built
   * without it (e.g. a bare contracts builder) simply omit the field. The
   * value is NEVER an exact match — npm/filesystem/install-channel are
   * unobserved at runtime — so agents must distinguish the row's published
   * status from the local `match`.
   */
  readonly hostSupport?: AgentHostSupport;
  readonly notes: readonly string[];
}

/**
 * Named input for the sole catalog content builder (`buildAgentCatalog` in
 * @opensip-cli/shared-analysis). Readonly and self-contained: it carries the
 * admitted `tools`, the internal command denylist, an already-bounded project
 * context, the caller-controlled `validateOverlays` flag, the injected
 * reserved-name lists (ADR-0159), and Plan 02's process-only host-support
 * projection. Extracted (was anonymous) so both transports name the same input
 * and a new common field cannot silently reach only one adapter.
 */
export interface AgentCatalogBuildInput {
  readonly tools?: ToolRegistry;
  readonly internalCommands?: ReadonlySet<string>;
  readonly projectContext?: AgentProjectContext;
  readonly validateOverlays?: boolean;
  readonly reservedNames?: AgentCatalog['reservedNames'];
  readonly hostSupport?: AgentHostSupport;
}
