/**
 * @fileoverview Capability domain model (release 2.10.0, §5.3).
 *
 * A **capability domain** is a named extension point a tool OWNS — "fit
 * has checks", "sim has scenarios", "graph has language adapters". Today
 * the host knows these by a compiled-in enum (`MARKER_KINDS` in
 * `marker-discovery.ts`). The capability model turns that knowledge into
 * DATA: a tool declares the domains it owns in its static manifest
 * (`ToolPluginManifest.capabilities`), and the host registers each one in
 * a per-run capability registry WITHOUT being compiled to understand it.
 *
 * The host's only jobs are (a) record that a declared domain exists and
 * who owns it, and (b) route an incoming contribution to the owning tool's
 * registrar after checking it targets a declared domain and passes that
 * domain's `contributionSchema`. The host never interprets the
 * contribution itself — the owner supplies the registrar.
 *
 * `contributionSchema` is `unknown` at the kernel layer ON PURPOSE: `core`
 * carries no Zod (the composer in `@opensip-tools/config` does). A domain
 * validates a contribution either structurally (the host applies a
 * built-in shallow check) or via an owner-supplied validator function
 * (see {@link CapabilityValidator}) — never by importing a schema library
 * into the kernel.
 *
 * These types live in **core** next to the `Tool` contract + manifest;
 * `contracts` re-exports them for the public surface (core cannot import
 * contracts).
 */

/**
 * How a contribution to a capability domain is delivered. Mirrors the
 * three ways a pack contributes today, so an external tool can declare
 * the same shapes the first-party tools use:
 *
 *   - `module-export` — a value exported from a discovered `.mjs`/package
 *     module (checks, scenarios, recipes).
 *   - `manifest-entry` — a declaration carried inline in a manifest block.
 *   - `file`          — a file on disk the owner reads (a scenario script,
 *     a config sidecar).
 */
export type CapabilityContributionKind = 'module-export' | 'manifest-entry' | 'file';

/**
 * How a domain's contribution PACKAGES are found on disk — the data the generic
 * discovery substrate reads so the host never compiles in "fit has checks" /
 * "graph has adapters" knowledge (§5.3). Two modes, mirroring the two shapes the
 * first-party tools use:
 *
 *   - `marker` — packages declaring `package.json#opensipTools.kind === markerKind`
 *     (fit's `fit-pack`, graph's `graph-adapter`).
 *   - `name-pattern` — packages named `<scope>/<prefix>*` under a set of scopes
 *     (sim's `@opensip-tools/scenarios-*`). A legitimate, ADR-documented per-domain
 *     difference (§6.7): the descriptor exists precisely to carry it.
 */
export type CapabilityDiscoveryMode =
  | { readonly mode: 'marker'; readonly markerKind: string }
  | { readonly mode: 'name-pattern'; readonly prefix: string; readonly defaultScopes: readonly string[] };

/**
 * A SECONDARY export the same package walk also routes — to a (usually different)
 * domain. The §5.3 separate-domains fold: a fit-pack/sim-pack package exports both
 * its primary contributions (`checks`/`scenarios`) AND co-located `recipes`; the
 * recipes are routed to a `fit-recipe`/`sim-recipe` domain by the SAME discovery
 * walk, each item still schema-checked against its OWN domain. Tool-agnostic.
 */
export interface CapabilityCoContribution {
  /** The module export holding the secondary contributions (e.g. `recipes`). */
  readonly exportName: string;
  /** Whether `exportName` is an array of contributions or a single one. */
  readonly exportShape: 'array' | 'single';
  /** The domain id these secondary contributions route to (e.g. `fit-recipe`). */
  readonly domainId: string;
}

/**
 * The static descriptor for how a capability domain's contributions are
 * discovered and loaded — declared in the owning tool's manifest
 * (`ToolPluginManifest.capabilities[].discovery`) and read by the generic
 * discovery substrate. Tool-agnostic by construction: the host walks/loads from
 * this datum, never from compiled-in per-domain code.
 */
export interface CapabilityDiscoveryDescriptor {
  /** The on-disk discovery mode (marker or name-pattern). */
  readonly discovery: CapabilityDiscoveryMode;
  /** The module export the contributions live under (`checks`/`scenarios`/`adapter`). */
  readonly exportName: string;
  /** Whether `exportName` is an array of contributions or a single one. */
  readonly exportShape: 'array' | 'single';
  /**
   * The `opensip-tools.config.yml` `plugins.*` keys this domain's preferences live
   * under (the existing per-domain keys, mapped so the documented config keeps
   * working unchanged). Omitted keys default to "auto-discover on, no explicit list".
   */
  readonly configKeys: {
    readonly packages?: string;
    readonly autoDiscover?: string;
    readonly scopes?: string;
  };
  /**
   * Optional package scope that marks a BUILT-IN contribution pack (resolved from
   * the CLI install dir) vs a custom one (resolved from the project) — e.g. fit
   * splits `@opensip-tools/` built-in check packs from project-local ones.
   */
  readonly builtinScope?: string;
  /**
   * How an explicit package list (`configKeys.packages`) interacts with
   * auto-discovery:
   *   - `'replace'` (default) — an explicit list WINS; auto-discovery is skipped
   *     (sim/graph: a pinned list is deterministic).
   *   - `'augment'` — the explicit list is ADDED to auto-discovery, deduped (fit:
   *     `checkPackages` names packs that don't declare the marker yet, on top of
   *     marker discovery).
   */
  readonly explicitListMode?: 'replace' | 'augment';
  /**
   * Secondary exports the same package walk also routes to OTHER domains (§5.3
   * separate-domains fold) — e.g. a fit-pack's co-located `recipes` routed to the
   * `fit-recipe` domain. Each is read from every discovered package alongside the
   * primary export.
   */
  readonly coContributions?: readonly CapabilityCoContribution[];
}

/**
 * The static description of a capability domain a tool owns. Declared in
 * the owning tool's manifest (see {@link ToolCapabilityDeclaration}) and
 * registered into the per-run {@link CapabilityRegistry} alongside the
 * owner-supplied registrar.
 *
 * The host stores this verbatim and uses it only to (a) confirm a routed
 * contribution targets a declared domain and (b) validate the contribution
 * against `contributionSchema` before handing it to the registrar. It is
 * deliberately tool-agnostic — the kernel never reads a domain-specific
 * field.
 */
export interface CapabilityDomainSpec {
  /** Stable domain id — e.g. 'fit-pack', 'sim-pack', 'graph-adapter', 'audit-rule'. */
  readonly id: string;
  /** The `ToolPluginManifest.id` of the tool that owns this domain. */
  readonly ownerToolId: string;
  /**
   * Coarse integer epoch for THIS domain's contribution contract (distinct
   * from the plugin-API epoch). Bumped when the contribution shape changes
   * incompatibly; lets a domain version its own extension point.
   */
  readonly apiVersion: number;
  /**
   * The contract a contribution must satisfy. `unknown` at the kernel
   * layer — the host validates it structurally (a shallow required-keys
   * record, see {@link StructuralContributionSchema}) or via an
   * owner-supplied {@link CapabilityValidator}. NEVER a Zod schema in core.
   */
  readonly contributionSchema: unknown;
  /** How contributions to this domain are delivered. */
  readonly contributionKind: CapabilityContributionKind;
  /**
   * How this domain's contribution packages are discovered + loaded (§5.3). When
   * present, the generic discovery substrate auto-discovers contributions for this
   * domain from it; when absent, the domain receives only explicit/manifest
   * contributions (no auto-discovery).
   */
  readonly discovery?: CapabilityDiscoveryDescriptor;
}

/**
 * A capability-domain declaration as it appears in a tool's static
 * manifest (`ToolPluginManifest.capabilities[]`). Identical in shape to
 * the runtime {@link CapabilityDomainSpec} EXCEPT `ownerToolId` is
 * implied by the manifest's own `id` (the host stamps it on at read time),
 * so a manifest author never repeats the owner id.
 *
 * Optional and additive: a manifest with no `capabilities` simply
 * contributes no domains, and `MARKER_KINDS` remains the bootstrap-default
 * vocabulary (a manifest domain EXTENDS that set, never replaces it).
 */
export interface ToolCapabilityDeclaration {
  /** Stable domain id this tool declares ownership of. */
  readonly id: string;
  /** Contribution-contract epoch for this domain. */
  readonly apiVersion: number;
  /** The contribution contract (structural record or validator). `unknown` in core. */
  readonly contributionSchema: unknown;
  /** How contributions to this domain are delivered. */
  readonly contributionKind: CapabilityContributionKind;
  /** How this domain's contribution packages are discovered + loaded (§5.3). */
  readonly discovery?: CapabilityDiscoveryDescriptor;
}

/**
 * The owner-supplied callback the host invokes once a contribution has passed
 * the domain's schema check. The host hands the validated contribution
 * straight through — it never inspects the contribution's domain-specific
 * meaning. The registrar performs the actual registration into the owning
 * tool's own registry (a `CheckRegistry`, scenario `Registry`, graph-adapter
 * registry, …).
 *
 * Defined HERE (the leaf domain model) rather than in the host-side
 * `capability-registry.ts` so the `Tool` contract (`tools/types.ts`) can name
 * it without importing the host registry — which would pull in
 * `lib/run-scope.ts` and reintroduce the `run-scope → … → tools/types`
 * import cycle. `capability-registry.ts` re-exports it for back-compat.
 */
export type CapabilityRegistrar = (contribution: unknown) => void;

/**
 * A tool's namespaced configuration contribution, as the kernel sees it
 * (release 2.10.0, ADR-0023, Phase 4). The concrete schema-bearing type —
 * `ToolConfigDeclaration` — lives in `@opensip-tools/config` (which carries
 * Zod); core must not depend on config or Zod, so this kernel-side carrier
 * keeps `schema` (and `defaults`/`env`) `unknown`. The composition root (the
 * CLI, which DOES import `@opensip-tools/config`) narrows a tool's `config`
 * slot back to the concrete `ToolConfigDeclaration` when it gathers the
 * declarations to compose + validate the whole document.
 *
 * Any `ToolConfigDeclaration` is structurally assignable to this carrier (a
 * `ZodType` is assignable to `unknown`), so a tool sets `config: myDeclaration`
 * directly. Defined here (not in the host registry) so the leaf `Tool`
 * contract can name it without an import cycle.
 */
export interface ToolConfigContribution {
  /** Top-level config key owned by this tool (e.g. `graph`, `fitness`). */
  readonly namespace: string;
  /** The tool's namespace schema — a Zod schema at the config layer, `unknown` here. */
  readonly schema: unknown;
  /** Optional defaults for the namespace (lowest-precedence source). */
  readonly defaults?: unknown;
  /** Optional environment-variable bindings for keys in this namespace. */
  readonly env?: unknown;
}

/**
 * An owner-supplied validator: returns `true` when `contribution` satisfies
 * the domain's contract, or a string explaining why it does not. A domain
 * whose `contributionSchema` is a function is validated by CALLING it; this
 * is how a domain expresses a richer-than-structural contract without
 * dragging a schema library into the kernel.
 */
export type CapabilityValidator = (contribution: unknown) => true | string;

/**
 * A structural contribution schema: the kernel's Zod-free default. Each
 * listed key must be PRESENT (and non-`undefined`) on the contribution
 * record; an optional `kind` predicate further narrows the value. The host
 * checks these shallowly — enough to reject an obviously wrong-shaped
 * contribution before it reaches the owner's registrar, without the kernel
 * understanding the domain.
 */
export interface StructuralContributionSchema {
  /** Keys that must be present (and not `undefined`) on the contribution. */
  readonly requiredKeys: readonly string[];
}

/**
 * Type guard: a `contributionSchema` is an owner-supplied validator
 * function (validated by calling it) rather than a structural record.
 */
export function isCapabilityValidator(schema: unknown): schema is CapabilityValidator {
  return typeof schema === 'function';
}

/**
 * Type guard: a `contributionSchema` is a {@link StructuralContributionSchema}
 * (a `{ requiredKeys: string[] }` record the host checks shallowly).
 */
export function isStructuralContributionSchema(
  schema: unknown,
): schema is StructuralContributionSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    Array.isArray((schema as { requiredKeys?: unknown }).requiredKeys) &&
    (schema as { requiredKeys: unknown[] }).requiredKeys.every((k) => typeof k === 'string')
  );
}
