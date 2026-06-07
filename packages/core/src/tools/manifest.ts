/**
 * @fileoverview Static tool-plugin manifest + the plugin-API epoch +
 * provenance types (release 2.8.0, identity & compatibility).
 *
 * The **manifest** is the static front matter the host reads *before*
 * importing a tool's runtime `Tool` module (north-star §5.1). It is
 * declared in `package.json#opensipTools` for bundled + installed tools
 * (one read for both) and as a JSON sidecar for project-local tools.
 *
 * `PLUGIN_API_VERSION` is a coarse integer **epoch** for the plugin
 * *input* contract. A tool declares the epoch it was compiled against
 * via `ToolPluginManifest.apiVersion`; the host's single
 * `checkCompatibility()` gate (see `compatibility.ts`) admits or rejects
 * on that integer alone — no semver range maths.
 *
 * For 2.8.0 only the **identity subset** (`kind`/`id`/`name`/`version`/
 * `apiVersion` + command metadata) is consumed. The richer fields
 * (`capabilities`/`config`/`dashboard`/…) are typed-but-not-consumed
 * placeholders for later releases (§5.3/§5.7 → 2.9.0+), so a manifest
 * authored today stays forward-shaped.
 *
 * These types live in **core** (next to the `Tool` contract). `contracts`
 * re-exports them for the public surface; core cannot import contracts.
 */

import type { ToolCapabilityDeclaration } from './capability.js';

/**
 * The plugin-API epoch the running engine implements.
 *
 * A coarse integer, bumped only on a breaking change to the plugin
 * *input* contract. A tool manifest's `apiVersion` is compared against
 * this single value by `checkCompatibility()`; an omitted `apiVersion`
 * is treated as "current epoch" (the grace window).
 */
export const PLUGIN_API_VERSION = 1;

/**
 * Where a tool plugin came from. Drives the trust policy and the
 * provenance record surfaced in structured logs + `plugin list`.
 *
 *   - `bundled`       — a first-party tool shipped with the CLI.
 *   - `installed`     — an npm package discovered via tool-package-discovery.
 *   - `project-local` — a tool authored under the project's
 *                       `opensip-tools/` tree (JSON-sidecar manifest).
 */
export type ToolSource = 'bundled' | 'installed' | 'project-local';

/**
 * Identity of a command a tool contributes, as declared in the static
 * manifest. Mirrors the runtime `ToolCommandDescriptor` (`types.ts`) so
 * the bundled path can assert manifest⇔`Tool.commands` equality (Phase 1).
 */
export interface ToolCommandManifest {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

/**
 * The static front matter a tool plugin declares (in
 * `package.json#opensipTools` or a JSON sidecar) so the host can inspect
 * its identity + contract epoch **without importing the runtime module**.
 *
 * For 2.8.0 the host consumes only the identity subset
 * (`kind`/`id`/`name`/`version`/`apiVersion`/`commands`). The remaining
 * fields are typed-but-not-consumed placeholders for later releases so a
 * manifest authored today is forward-shaped; they are deliberately
 * `unknown`-shaped until a release gives them concrete semantics.
 *
 * Release 2.10.0 (§5.3) gives `capabilities` its concrete shape — an
 * array of {@link ToolCapabilityDeclaration} (the capability domains the
 * tool OWNS). It stays OPTIONAL and additive: a manifest with no
 * `capabilities` declares no domains, and `MARKER_KINDS` remains the
 * bootstrap-default domain vocabulary. The other slots stay `unknown`.
 */
export interface ToolPluginManifest {
  /** Discriminator — always `'tool'` (matches `opensipTools.kind`). */
  readonly kind: 'tool';
  /** Stable identifier — e.g. 'fitness', 'simulation', 'graph'. */
  readonly id: string;
  /** Human-facing display name. */
  readonly name: string;
  /** Display semver of the tool itself (NOT the contract epoch). */
  readonly version: string;
  /**
   * The plugin-API epoch this tool was compiled against. Omitted ⇒
   * grace window: the host treats it as the current `PLUGIN_API_VERSION`.
   */
  readonly apiVersion?: number;
  /** Command identities the tool contributes — `--help` / conflict detection. */
  readonly commands: readonly ToolCommandManifest[];

  // ── Typed-but-not-consumed until later releases ────────────────────
  // These keep a 2.8.0-authored manifest forward-shaped. They are
  // `unknown` (not concrete) on purpose: the release that consumes each
  // one defines its shape; declaring a shape now would over-commit.
  /**
   * §5.3 → 2.10.0: the capability domains this tool OWNS. Each entry is a
   * {@link ToolCapabilityDeclaration} (id + contribution epoch + schema +
   * kind); the host stamps `ownerToolId = this.id` and registers each into
   * the per-run capability registry, EXTENDING the `MARKER_KINDS` bootstrap
   * vocabulary without a host-enum edit. Optional + additive.
   */
  readonly capabilities?: readonly ToolCapabilityDeclaration[];
  /** §5.7 → 2.9.0: tool-owned config schema descriptor. */
  readonly config?: unknown;
  /** Later: dashboard-contribution descriptor. */
  readonly dashboard?: unknown;
  /** Later: sessions-contribution descriptor. */
  readonly sessions?: unknown;
  /** Later: declared plugin domains the tool hosts. */
  readonly pluginDomains?: readonly unknown[];
  /** Later: declared host/peer requirements. */
  readonly requires?: readonly unknown[];
}

/**
 * The provenance record the host attaches when it admits a tool —
 * source + identity + a hash of the manifest it read. Surfaced via
 * structured logs on load and via `plugin list` (Phase 4).
 */
export interface ToolProvenance {
  /** Where the tool came from. */
  readonly source: ToolSource;
  /** The tool's stable id (from the manifest). */
  readonly id: string;
  /** The tool's display version (from the manifest). */
  readonly version: string;
  /** npm package name, when the tool is an installed/bundled package. */
  readonly packageName?: string;
  /** Filesystem path the manifest was resolved from, when applicable. */
  readonly resolvedPath?: string;
  /** Stable hash of the manifest bytes the host read — tamper/identity check. */
  readonly manifestHash: string;
}
