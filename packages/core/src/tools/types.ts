/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * mounts each tool's declared `commandSpecs`.
 *
 * Tools are first-party (declared as a direct dep of opensip-cli)
 * or third-party (any npm package whose package.json declares
 * `opensipTools.kind === 'tool'` — discovered via tool-package-discovery).
 *
 * Contract:
 *   - `commands[]` carries metadata only (name + description, used for
 *     `--help` listings and conflict detection).
 *   - The actual subcommand wiring is host-owned: the tool declares typed
 *     `commandSpecs` and the host's `mountCommandSpec` mounts each one
 *     (1.0.0 launch — `register()` and the raw-Commander `program` handle were
 *     removed; "one command surface", §8).
 *
 * The two-field shape (commands[] for metadata; commandSpecs for the typed
 * command surface) keeps `--help` discovery cheap (no per-tool Commander
 * invocation required to enumerate available commands) while the host owns
 * the full option-parsing / output / error pipeline for every command.
 *
 * ## Module map (M6 split)
 *
 * This file is the cohesive Tool contract hub: the `Tool` interface plus its
 * immediate metadata (`ToolMetadata`, `ToolCommandDescriptor`,
 * `ToolExtensionPoints`, `ToolPluginExports`) and the `TOOL_CONTRACT_VERSION`
 * constant. The rest of the (formerly kitchen-sink) contract surface lives in
 * cohesive sibling modules and is re-exported here so the public
 * `@opensip-cli/core` surface is byte-identical:
 *   - `./host-planes.js`  — HostGovernance/HostAudit/HostEntitlements + records
 *   - `./cli-context.js`  — ToolCliContext (+ the WireSignalEnvelope alias)
 *   - `./tool-sessions.js`— generic-session contract leaves
 *   - `./live-view.js`    — LiveViewContext/LiveViewRenderer/UnknownLiveViewError
 *   - `./tool-results.js` — GateCompareResult/SignalDeliveryResult
 */

import type { CapabilityRegistrar, ToolConfigContribution } from './capability.js';
import type { ToolIdentity } from './identity.js';
import type { ToolCliContext } from './cli-context.js';
import type { CommandSpec } from './command-spec.js';
import type { ScaffoldContext, ScaffoldFile } from './scaffold.js';
import type { ToolSessionReplayContribution } from './tool-sessions.js';
import type { FingerprintStrategy } from '../baseline/fingerprint-strategy.js';
import type { ContributeScopeResult, ToolScope } from '../lib/scope-types.js';
import type { PluginLayout } from '../plugins/types.js';

// Re-export the moved contract surface so `import { X } from '.../tools/types.js'`
// and the `@opensip-cli/core` barrel keep resolving every name (M6: the public
// surface is unchanged — these were all defined inline here before the split).
// Siblings import shared types directly from each other / from this hub's
// imported leaves (never from this barrel) so there is no import cycle.
export * from './host-planes.js';
export * from './cli-context.js';
export * from './tool-sessions.js';
export * from './live-view.js';
export * from './tool-results.js';

// `ToolScope` (the Tool-facing scope view) and `ScopeContribution` (the
// augmentable subscope bag a tool returns from `contributeScope`) live in
// the leaf `lib/scope-types.ts`. The `Tool` contract depends on those
// abstractions, never on the concrete `RunScope`, so there is no
// `tools/types.ts → lib/run-scope.ts` edge — the former RunScope⟷Tool
// type cycle is gone (audit 2026-05-29, M4). A plain top-level
// `import type` is safe: scope-types is a leaf with no edge back here.

/**
 * The current version of the `Tool` plugin contract.
 *
 * Tool authors may optionally set `contractVersion: TOOL_CONTRACT_VERSION`
 * (or a string matching a future version) on their exported `Tool` object.
 *
 * ## Versioning Policy (ADR-0046)
 *
 * - `TOOL_CONTRACT_VERSION` is bumped **only** when the shape or documented
 *   semantics of the `Tool` interface (or the `ToolExtensionPoints` contract)
 *   actually change in a way that could affect tool authors.
 * - When a contract change ships, the value is set to the major.minor of the
 *   CLI release in which the change is first released (e.g. a breaking contract
 *   change released as part of CLI v1.2.0 results in
 *   `TOOL_CONTRACT_VERSION = '1.2'`).
 * - Releases that do not touch the Tool contract leave the constant at its
 *   previous value (it will frequently lag the CLI version — this is
 *   intentional).
 * - The primary evolution mechanism remains `extensionPoints` (see below and
 *   the `Tool` interface JSDoc). `contractVersion` is a marker only.
 *
 * The host can use the declared value for diagnostics, logging
 * ("tool X was written against contract vY"), future compatibility warnings,
 * or ratcheting in the plugin loader / compatibility gate.
 *
 * See ADR-0046 for the full policy, alternatives considered, and enforcement.
 */
export const TOOL_CONTRACT_VERSION = '1.0.0';

/** Static descriptor for a tool plugin: id, semver, and one-line description. */
export interface ToolMetadata {
  /**
   * Stable identity (real UUID). Matches the `id` field used for Checks'
   * stable UUID (per ADR-0048 and governing spec). Used for durable DB
   * scoping, provenance, agent-catalog, future ratchets, etc.
   */
  readonly id: string;
  /**
   * Human-facing name / current key (what was previously stored in the old
   * `id` field). Used for UX, config namespaces, CLI short forms, on-disk
   * hints, and current DB `tool` column values.
   */
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

/**
 * Identity of a command a tool contributes — used for --help, plugin
 * listings, and conflict detection across tools. The actual handler is
 * wired up by the tool's `commandSpecs` (mounted by the host).
 */
export interface ToolCommandDescriptor {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  /**
   * Command visibility tier (taxonomy spec). `'public'` (default) commands
   * appear in `--help`, shell completion, and the agent-catalog primary
   * surface. `'internal'` commands (Tier-3: `*-run-worker`, `*-shard-worker`,
   * `*-equivalence-check`) are IPC/CI bootstrap entry points (ADR-0028) that
   * stay invocable directly but are hidden from those public surfaces. They
   * are revealed only by `OPENSIP_CLI_SHOW_INTERNAL=1`. Omitted ⇒ `'public'`.
   */
  readonly visibility?: 'public' | 'internal';
  /**
   * When set, this command is mounted as a SUBCOMMAND of the named parent
   * command (the tool's primary verb, e.g. `'graph'` / `'fit'`) instead of
   * flat at the root program. Enables the `<tool> <verb>` grammar
   * (`graph export`, `fit list`). The host nests `parent`-matched children
   * onto the primary in `mountOneTool` (Task 0.4). Omitted ⇒ flat root mount.
   */
  readonly parent?: string;
  /**
   * Whether this command requires a project context (RunScope with datastore etc.).
   * Mirrors CommandSpec.scope. 'project' (default for most) vs 'none' (e.g. configure).
   * Populated from the tool's CommandSpec so the declared scope drives host behavior
   * (pre-action guards, etc.) instead of a hardcoded name list.
   */
  readonly scope?: 'project' | 'none';
}

/**
 * Tool error-handling contract.
 *
 * Tools have two paths for surfacing failure to the CLI dispatcher:
 *
 *   1. **Result-shaped return** — for expected business outcomes that
 *      callers may want to render with full UX (Ink, JSON, dashboard).
 *      Action handlers compute a `CommandResult` (`type: 'error'` is
 *      one variant) and pass it through `cli.render` / `cli.emitJson`,
 *      setting the exit code via `cli.setExitCode`. Both `simulation`
 *      and `graph` use this path for normal failures.
 *
 *   2. **Throw a `ToolError` subclass** — for unrecoverable / programmer
 *      conditions, or for known-error classes that the tool would
 *      rather let the central handler map to an exit code. The CLI's
 *      top-level `handleParseError` catches every `ToolError` that
 *      escapes a tool's action body and routes it through the
 *      canonical `mapToolErrorToExitCode` (in `@opensip-cli/contracts`).
 *
 * Which subclass to throw, by intent:
 *
 *   - `ConfigurationError` — bad user input / missing config / wrong
 *     flag combination. Exit code: `CONFIGURATION_ERROR` (2).
 *   - `ValidationError`    — a validated value failed an invariant.
 *     Exit code: `CONFIGURATION_ERROR` (2).
 *   - `NotFoundError`      — a named entity (check, recipe, scenario)
 *     does not exist. Exit code: `CHECK_NOT_FOUND` (3).
 *   - `NetworkError`       — remote call failed (e.g. `--report-to`).
 *     Exit code: `REPORT_FAILED` (4).
 *   - `TimeoutError`       — an operation exceeded its deadline.
 *     Exit code: `RUNTIME_ERROR` (1).
 *   - `SystemError`        — bootstrap-invariant violation or data
 *     corruption. Exit code: `RUNTIME_ERROR` (1).
 *   - bare `ToolError`     — any other tool failure. Exit code:
 *     `RUNTIME_ERROR` (1).
 *
 * Tools that need to catch their own `ToolError` locally (e.g. to
 * render in a non-Ink format) should still derive the exit code from
 * `mapToolErrorToExitCode` rather than hardcoding the constant — that
 * keeps a single source of truth for the policy.
 *
 * Plain `Error` instances thrown from a tool action body fall through
 * to the data-driven `getErrorSuggestion` substring matcher, then to a
 * generic `RUNTIME_ERROR`. Prefer the typed path.
 */

/**
 * Bag for extension points and rarer/future hooks.
 *
 * ## Why this bag exists (discoverability)
 *
 * The main `Tool` interface is deliberately kept as "one cohesive interface"
 * that every tool author implements. To prevent it from becoming a god
 * interface over time, **new or experimental concerns should be added here**
 * rather than as new top-level optional members.
 *
 * This is the official evolution path for the Tool contract.
 *
 * ## What belongs here
 * - Optional lifecycle hooks (initialize, contributeScope, etc.)
 * - Future capabilities, community distribution metadata, etc.
 * - Host-plane participation declarations (governance / audit / entitlements)
 *
 * See the JSDoc on the `Tool` interface for the recommended grouping and
 * the "Evolution Path" guidance. Also see ADR-0027 and ADR-0038.
 */
export interface ToolExtensionPoints {
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

  // Per-tool contract versions (ADR-0047). Each tool declares its own domain
  // surface version here (the evolution bag) rather than on the main Tool
  // interface, so the core contract stays narrow while per-tool surfaces evolve
  // independently of core's TOOL_CONTRACT_VERSION.
  readonly fitnessContractVersion?: string;
  readonly graphContractVersion?: string;
  readonly simulationContractVersion?: string;
  readonly yagniContractVersion?: string;
}

/**
 * The contract every first-party, installed, or project-local tool implements
 * (`fitness`, `simulation`, `graph`, …).
 *
 * A tool declares its metadata and `commandSpecs` (the **only** command surface).
 * The host (`cli`) loads every tool through the same dynamic-import plugin path;
 * nothing here distinguishes a bundled tool from an installed one (ADR-0027).
 *
 * ## Design note (architecture review)
 *
 * The surface is deliberately *rich and cohesive* rather than a minimal set of
 * narrow interfaces. New or rare concerns are routed through the `extensionPoints`
 * bag (or top-level optionals that predate the bag) + per-tool `*ContractVersion`
 * fields (ADR-0046, ADR-0047). This keeps the core Tool contract stable while
 * allowing independent evolution of fitness/graph/simulation surfaces. The trade-off
 * (larger surface for tool authors, coordination for new capability *domains*)
 * was accepted in favor of a single place to look for "what can a tool do?" and
 * to avoid a proliferation of tiny marker interfaces. See the evolution guidance
 * in the JSDoc below and in tool-lifecycle / capability docs.
 *
 * ## Contract Structure (for discoverability)
 *
 * The surface is intentionally one cohesive interface (see top-of-file comment).
 * It is organized into these logical groups:
 *
 * ### Stable Core Surface (most tools will implement these)
 * - `metadata`, `commands`, `pluginLayout`, `commandSpecs`
 *
 * ### Lifecycle & Host Integration (optional)
 * - `initialize`, `contributeScope`, `collectReportData`, `sessionReplay`,
 *   `config`, `capabilityRegistrars`, `fingerprintStrategy`
 *
 * ### Scaffolding / `init` support (ADR-0038)
 * - `scaffoldExamples`, `stableExampleIds`, `scaffoldConfigBlock`
 *
 * ### Evolution Path (strongly preferred for new concerns)
 * - `extensionPoints` (see `ToolExtensionPoints` below)
 *
 * ## Future-Proofing
 *
 * Use the exported `TOOL_CONTRACT_VERSION` in your `contractVersion` field
 * when you author a tool. New or experimental capabilities should go into
 * `extensionPoints` rather than new top-level members.
 *
 * The host provides typed seams on `ToolCliContext` (including the typed
 * `hostPlanes` bag for governance/audit/entitlements).
 */
export interface Tool {
  // ── Core Identity ──────────────────────────────────────────────────────
  /** Author-facing identity declaration; host derives names from this. */
  readonly identity: ToolIdentity;
  readonly metadata: ToolMetadata;

  /**
   * Optional marker for which version of the Tool contract this
   * implementation was authored against.
   *
   * Recommended usage:
   *   contractVersion: TOOL_CONTRACT_VERSION
   *
   * See the exported `TOOL_CONTRACT_VERSION` constant for rationale and
   * future evolution notes. This field is purely advisory for now.
   */
  readonly contractVersion?: string;

  /**
   * Derived command descriptors for --help and conflict detection. Authors
   * should omit this when using {@link defineTool} — it is derived from
   * `commandSpecs` via {@link resolveToolCommands}.
   */
  readonly commands?: readonly ToolCommandDescriptor[];
  /**
   * Optional project-local plugin layout. Tools that support
   * user-authored / npm plugins under `<project>/opensip-cli/<domain>/`
   * declare `{ domain, userSubdirs }` here; the kernel's `discoverPlugins`
   * / `loadAllPlugins` and the CLI's `plugin` command read it instead of
   * hardcoding domain names (ADR-0009 corollary 1). Tools with no
   * project-local plugins (e.g. graph) leave this undefined.
   */
  readonly pluginLayout?: PluginLayout;
  /**
   * Declarative command surface (launch, north-star §5.4). The
   * PREFERRED way a tool contributes commands: it returns one
   * {@link CommandSpec} per subcommand and the host's `mountCommandSpec`
   * (cli, Phase 1) translates each into a wired Commander command — the tool
   * never touches Commander. Specs are typed against the concrete host
   * {@link ToolCliContext} (the kernel's default `CommandContext` marker isn't
   * assignable to it), so a tool authors them via
   * `defineCommand<TOpts, ToolCliContext>(...)`.
   *
   * The host mounts each spec via `mountCommandSpec` (the ONLY command surface
   * as of launch — `register()` was removed). A tool that declares no
   * `commandSpecs` contributes no commands (a mis-declaration the host surfaces
   * loudly via `cli.tool.no_command_surface`).
   *
   * Typed `CommandSpec<unknown, ToolCliContext>` (the kernel cannot name the
   * per-spec `TOpts`); the host's `mountCommandSpec` narrows each spec.
   */
  readonly commandSpecs?: readonly CommandSpec<unknown, ToolCliContext>[];
  /**
   * Optional hooks and extension points. All lifecycle hooks live here;
   * use {@link resolveToolHooks} to read them.
   */
  readonly extensionPoints?: ToolExtensionPoints;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}
