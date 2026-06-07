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
