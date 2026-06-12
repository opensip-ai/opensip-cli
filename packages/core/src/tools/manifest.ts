/**
 * @fileoverview Static tool-plugin manifest + the plugin-API epoch +
 * provenance types (release 3.0.0, raw-vs-admitted compatibility contract).
 *
 * The **manifest** is the static front matter the host reads *before*
 * importing a tool's runtime `Tool` module (north-star §5.1). It is
 * declared in `package.json#opensipTools` for bundled + installed tools
 * (one read for both) and as a JSON sidecar for project-local tools.
 *
 * `PLUGIN_API_VERSION` is a coarse integer **epoch** for the plugin
 * *input* contract. A tool declares the epoch it was compiled against
 * via `RawToolPluginManifest.apiVersion`; the host's single
 * `checkCompatibility()` gate (see `compatibility.ts`) admits or rejects
 * on that integer alone — no semver range maths. Once admitted, the manifest is
 * represented as `ToolPluginManifest`, whose `apiVersion` is required.
 *
 * The host consumes identity + command metadata and, as of ADR-0029, the
 * concrete `capabilities` descriptor that declares owned capability domains.
 * Remaining fields (`config`/`dashboard`/…) stay typed-but-not-consumed
 * placeholders so a manifest authored today stays forward-shaped.
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
 * this single value by `checkCompatibility()`. A missing `apiVersion`
 * is incompatible as of 3.0.0; raw manifests stay representable so the
 * admission gate can diagnose unversioned inputs before rejecting them.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * Where a tool plugin came from. Drives the trust policy and the
 * provenance record surfaced in structured logs + `plugin list`.
 *
 *   - `bundled`       — a first-party tool shipped with the CLI
 *                       (trusted-by-shipping).
 *   - `installed`     — an npm package discovered via tool-package-discovery
 *                       (incl. `plugin add` / `plugin add --project`). Trusted
 *                       as an installed dependency.
 *   - `user-global`   — an authored sidecar under
 *                       `~/.opensip-tools/tools/<name>/`
 *                       (`opensip-tool.manifest.json`). The user placed it in
 *                       their own home dir (the `npm i -g` analogue for
 *                       authored code) → **trusted-by-default**.
 *   - `project-local` — an authored sidecar under
 *                       `<project>/opensip-tools/tools/<name>/`
 *                       (`opensip-tool.manifest.json`). It rides in with
 *                       `git clone` → **deny-by-default**; admitted only when
 *                       its id (or `*`) is allowlisted via
 *                       `OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS`.
 */
export type ToolSource = 'bundled' | 'installed' | 'user-global' | 'project-local';

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
 * The host consumes the identity subset
 * (`kind`/`id`/`name`/`version`/`apiVersion`/`commands`) plus the concrete
 * `capabilities` descriptor. The remaining fields are typed-but-not-consumed
 * placeholders for later releases so a manifest authored today is
 * forward-shaped; they are deliberately `unknown`-shaped until a release gives
 * them concrete semantics.
 *
 * Release 2.10.0 (§5.3) gives `capabilities` its concrete shape — an
 * array of {@link ToolCapabilityDeclaration} (the capability domains the
 * tool OWNS). It stays OPTIONAL and additive: a manifest with no
 * `capabilities` declares no domains, and `MARKER_KINDS` remains the
 * bootstrap-default domain vocabulary. The other slots stay `unknown`.
 */
interface ToolPluginManifestBase {
  /** Discriminator — always `'tool'` (matches `opensipTools.kind`). */
  readonly kind: 'tool';
  /** Stable identifier — e.g. 'fitness', 'simulation', 'graph'. */
  readonly id: string;
  /** Human-facing display name. */
  readonly name: string;
  /** Display semver of the tool itself (NOT the contract epoch). */
  readonly version: string;
  /** Command identities the tool contributes — `--help` / conflict detection. */
  readonly commands: readonly ToolCommandManifest[];

  // ── Typed-but-not-consumed until later releases ────────────────────
  // These keep a 3.0.0-authored manifest forward-shaped. They are
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

  // ── Reserved for community / catalog (ecosystem vision) ─────────────
  // These are additive reservations (not yet consumed) so manifests
  // authored for GA remain forward-shaped for the future community
  // marketplace, distribution modes, compatibility declarations,
  // org-scoped registries, and paid-extension support described in the
  // product ecosystem vision (docs/business/product-ecosystem-vision.md).
  // See the second-pass architecture review (GA blocker on forward-compat
  // in manifests/admission). The shape will be defined by the release
  // that first consumes them.
  /** Reserved: compatibility metadata (minApiVersion, languages, etc.). */
  readonly compatibility?: unknown;
  /** Reserved: distribution posture for community/catalog. */
  readonly distribution?: 'private' | 'public-free' | 'public-paid' | unknown; // eslint-disable-line @typescript-eslint/no-redundant-type-constituents -- unknown for forward-compat on reserved open field (loader may produce null/{}); see GA forward-compat work.
  /** General bag for future extension metadata (publisher, pricing, etc.). */
  readonly extensionMetadata?: unknown;
}

/**
 * Structurally valid manifest front matter before compatibility admission.
 * `apiVersion` is optional here only so the loader can represent and diagnose
 * 3.0.0-incompatible unversioned tools without pretending they are admitted.
 */
export interface RawToolPluginManifest extends ToolPluginManifestBase {
  /** The plugin-API epoch this tool was compiled against, if declared. */
  readonly apiVersion?: number;
}

/**
 * A manifest that passed the compatibility gate and can seed runtime surfaces
 * such as command mounting, provenance, and capability registration.
 */
export interface ToolPluginManifest extends ToolPluginManifestBase {
  /** The plugin-API epoch this admitted tool was compiled against. */
  readonly apiVersion: number;
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
