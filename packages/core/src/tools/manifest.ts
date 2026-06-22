/**
 * @fileoverview Static tool-plugin manifest + the plugin-API epoch +
 * provenance types (launch, raw-vs-admitted compatibility contract).
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
import type {
  ArgSpec,
  CommandOutputMode,
  CommandScopeRequirement,
  CommonFlagKey,
  OptionSpec,
  RawStreamReason,
} from './command-spec.js';
import type { ToolConfigManifestDescriptor } from './manifest-config.js';
import type { PluginLayout } from '../plugins/types.js'; // leaf import — manifest must not pull the plugins barrel

/**
 * The plugin-API epoch the running engine implements.
 *
 * A coarse integer, bumped only on a breaking change to the plugin
 * *input* contract. A tool manifest's `apiVersion` is compared against
 * this single value by `checkCompatibility()`. A missing `apiVersion`
 * is incompatible as of launch; raw manifests stay representable so the
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
 *                       `~/.opensip-cli/tools/<name>/`
 *                       (`opensip-tool.manifest.json`). The user placed it in
 *                       their own home dir (the `npm i -g` analogue for
 *                       authored code) → **trusted-by-default**.
 *   - `project-local` — an authored sidecar under
 *                       `<project>/opensip-cli/tools/<name>/`
 *                       (`opensip-tool.manifest.json`). It rides in with
 *                       `git clone` → **deny-by-default**; admitted only when
 *                       its id (or `*`) is allowlisted via
 *                       `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`.
 */
export type ToolSource = 'bundled' | 'installed' | 'user-global' | 'project-local';

/**
 * The serializable subset of {@link OptionSpec} a tool may declare in its static
 * manifest — every field EXCEPT the `parse` coercion closure (ADR-0054 M4-G).
 *
 * `OptionSpec.parse` is a runtime closure (a `(raw, previous) => next` reducer
 * Commander runs at parse time, e.g. `--concurrency` → Number). It cannot be
 * serialized, so it is the ONE thing the manifest cannot express. When the host
 * mounts an EXTERNAL tool's command shell from this descriptor, the option is
 * mounted WITHOUT a parse reducer — Commander passes the raw string/array
 * through, and the WORKER (which holds the tool's real spec) coerces in its
 * handler. A documented, deliberate narrowing — not a silent gap.
 */
export type ManifestOptionDescriptor = Omit<OptionSpec, 'parse'>;

/**
 * The serializable command SHELL a tool contributes, as declared in the static
 * manifest (ADR-0054 M4-G). Mirrors the runtime {@link CommandSpec} MINUS the
 * `handler` function and the non-serializable `OptionSpec.parse` closure, so the
 * host can mount an EXTERNAL tool's commands from the manifest ALONE — no runtime
 * import. The handler stays worker-owned and loads only at dispatch time.
 *
 * `name`/`description`/`aliases` are the historical identity subset (used for
 * `--help` + drift/conflict detection). The remaining fields are the M4-G shell:
 * the host synthesizes a {@link CommandSpec} from them to mount an external
 * command. All optional — a manifest that omits them gets the runtime
 * {@link CommandSpec} defaults (`commonFlags: []`, `scope: 'project'`,
 * `output: 'command-result'`, `visibility: 'public'`).
 */
export interface ToolCommandManifest {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];

  // ── ADR-0054 M4-G: the serializable command SHELL ────────────────────────
  /** Command visibility tier (mirrors {@link CommandSpec.visibility}). */
  readonly visibility?: 'public' | 'internal';
  /** Parent verb for `<tool> <verb>` nesting (mirrors {@link CommandSpec.parent}). */
  readonly parent?: string;
  /** The common flags this command exposes (mirrors {@link CommandSpec.commonFlags}). */
  readonly commonFlags?: readonly CommonFlagKey[];
  /** Tool-specific options, MINUS the `parse` closure (see {@link ManifestOptionDescriptor}). */
  readonly options?: readonly ManifestOptionDescriptor[];
  /** Positional arguments (mirrors {@link CommandSpec.args}; already plain data). */
  readonly args?: readonly ArgSpec[];
  /** Whether the host enters a project scope before dispatch (mirrors {@link CommandSpec.scope}). */
  readonly scope?: CommandScopeRequirement;
  /** How the host dispatches the handler's return (mirrors {@link CommandSpec.output}). */
  readonly output?: CommandOutputMode;
  /** Required when `output` is `raw-stream` (mirrors {@link CommandSpec.rawStreamReason}). */
  readonly rawStreamReason?: RawStreamReason;
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
 * Launch (§5.3) gives `capabilities` its concrete shape — an
 * array of {@link ToolCapabilityDeclaration} (the capability domains the
 * tool OWNS). It stays OPTIONAL and additive: a manifest with no
 * `capabilities` declares no domains, and `MARKER_KINDS` remains the
 * bootstrap-default domain vocabulary. The other slots stay `unknown`.
 */
interface ToolPluginManifestBase {
  /** Discriminator — always `'tool'` (matches `opensipTools.kind`). */
  readonly kind: 'tool';
  /**
   * Human/programmatic key (the value used for current storage, short ids,
   * config, etc.). For published tools this is the "declared" identifier.
   * This remains the manifest-side key for backward compat (ADR-0048).
   * The tool's stable machine identity (UUID) is declared here as `stableId`
   * (additive) when the tool author pins one; at runtime it appears as
   * `ToolMetadata.id` (with the human key in `ToolMetadata.name`).
   */
  readonly id: string;
  /**
   * Stable machine identity (real UUID) for this tool, matching the semantics
   * and field name of Checks' `id`. Declared additively by tools that opt into
   * durable identity (first-party tools declare it; community tools should too).
   * When present, the drift guard and provenance capture it.
   */
  readonly stableId?: string;
  /** Human-facing display name. */
  readonly name: string;
  /** Display semver of the tool itself (NOT the contract epoch). */
  readonly version: string;
  /** Command identities the tool contributes — `--help` / conflict detection. */
  readonly commands: readonly ToolCommandManifest[];

  // ── Typed-but-not-consumed until later releases ────────────────────
  // These keep a current manifest forward-shaped. They are
  // `unknown` (not concrete) on purpose: the release that consumes each
  // one defines its shape; declaring a shape now would over-commit.
  /**
   * §5.3 → Launch: the capability domains this tool OWNS. Each entry is a
   * {@link ToolCapabilityDeclaration} (id + contribution epoch + schema +
   * kind); the host stamps `ownerToolId = this.stableId ?? this.id` (ADR-0048:
   * the owner key must equal the owning tool's `metadata.id` — the stable UUID
   * for modern tools) and registers each into the per-run capability registry,
   * EXTENDING the `MARKER_KINDS` bootstrap vocabulary without a host-enum edit.
   * Optional + additive.
   */
  readonly capabilities?: readonly ToolCapabilityDeclaration[];
  /**
   * §5.7 → ADR-0054 M4-E: the tool-owned, serializable config-schema descriptor.
   * For an EXTERNAL tool this is the COARSE schema the host validates the tool's
   * config namespace against BEFORE forking — it never imports the tool's Zod
   * (the deep pass runs in the worker). A {@link ToolConfigManifestDescriptor}:
   * a namespace + a draft-07-subset JSON-Schema object. Optional; a tool that
   * declares no descriptor defers ALL of its config validation to the worker.
   */
  readonly config?: ToolConfigManifestDescriptor;
  /**
   * ADR-0054 M4-G: the tool's serializable plugin layout (`{ domain, userSubdirs }`,
   * mirroring the runtime {@link Tool.pluginLayout}). The host reads it to mount
   * the domain-bound `<tool> plugin …` extension-pack group + to drive `init`
   * scaffolding — WITHOUT importing the tool's runtime. A pack-supporting EXTERNAL
   * tool declares it so the host synthesizes the same plugin surface a bundled tool
   * gets. Omitted ⇒ the tool hosts no extension packs (no `plugin` subgroup).
   */
  readonly pluginLayout?: PluginLayout;
  /** Later: dashboard-contribution descriptor. */
  readonly dashboard?: unknown;
  /** Later: sessions-contribution descriptor. */
  readonly sessions?: unknown;
  /** Later: declared plugin domains the tool hosts. */
  readonly pluginDomains?: readonly unknown[];
  /** Later: declared host/peer requirements. */
  readonly requires?: readonly unknown[];

  // ── Reserved for community / catalog (ecosystem vision) ─────────────
  // These are additive reservations (currently unused) so manifests
  // authored for GA remain forward-shaped for the future community
  // marketplace, distribution modes, compatibility declarations,
  // org-scoped registries, and paid-extension support described in the
  // product ecosystem vision (cross-repo product strategy doc).
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
 * manifest-incompatible unversioned tools without pretending they are admitted.
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
  /** The tool's human/programmatic key (from the manifest). */
  readonly id: string;
  /** The tool's stable identity (real UUID) when declared (additive per ADR-0048). */
  readonly stableId?: string;
  /** The tool's display version (from the manifest). */
  readonly version: string;
  /** npm package name, when the tool is an installed/bundled package. */
  readonly packageName?: string;
  /** Filesystem path the manifest was resolved from, when applicable. */
  readonly resolvedPath?: string;
  /** Stable hash of the manifest bytes the host read — tamper/identity check. */
  readonly manifestHash: string;
}
