/**
 * @fileoverview Scope-owned capability registry (launch, §5.3).
 *
 * The host-side runtime for the capability model in `tools/capability.ts`.
 * A tool declares the domains it OWNS in its static manifest; the host
 * registers each declared domain here alongside the owner-supplied
 * REGISTRAR, then routes incoming contributions to the owning registrar
 * after a Zod-free schema check. The host never interprets a
 * contribution — it only confirms "targets a declared domain + passes its
 * schema" and hands off (north-star §4.5).
 *
 * **Per-`RunScope`, no module singleton.** Mirrors the simulation §5.11
 * template (`createScenarioRegistry` / `currentScenarioRegistry`):
 *
 *   - `createCapabilityRegistry()`  — factory the CLI bootstrap calls once
 *     per invocation, attaching the result to `scope.capabilities`.
 *   - `currentCapabilityRegistry()` — reads the scope-bound registry off
 *     `currentScope()`; throws when called outside a `RunScope`.
 *
 * Unlike a tool subscope, the capability registry is a KERNEL concern (the
 * host owns it, not any one tool), so its slot lives directly on
 * `ToolScope` (`capabilities?`) rather than under a tool's name. A run that
 * never constructs one carries `scope.capabilities === undefined` and reads
 * return `undefined`.
 *
 * Errors are typed + structured (§ Steps 2.1.3): an unknown domain is a
 * `NotFoundError` (`CAPABILITY.DOMAIN.UNKNOWN`); a schema mismatch is a
 * `ValidationError` (`CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH`), both
 * carrying a structured `diagnostic` for the CLI error boundary.
 */

import {
  CapabilitySchemaMismatchError,
  SystemError,
  UnknownCapabilityDomainError,
} from '../lib/errors.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { currentScope } from '../lib/run-scope.js';
import {
  isCapabilityValidator,
  isStructuralContributionSchema,
  type CapabilityDomainSpec,
  type CapabilityRegistrar,
} from '../tools/capability.js';

import type { ToolPluginManifest } from '../tools/manifest.js';

// `CapabilityRegistrar` now lives in the leaf `tools/capability.ts` so the
// `Tool` contract can name it without an import cycle through this host
// module. Re-export it here for back-compat with the prior import path.
export type { CapabilityRegistrar } from '../tools/capability.js';

/** A registered domain: its spec plus the owner's registrar. */
interface RegisteredDomain {
  readonly spec: CapabilityDomainSpec;
  readonly registrar: CapabilityRegistrar;
}

/**
 * Per-`RunScope` capability registry. Holds the declared domains (by id)
 * and routes contributions to their owners. Construct one per CLI
 * invocation via {@link createCapabilityRegistry}; read the scope-bound
 * instance via {@link currentCapabilityRegistry}.
 */
export class CapabilityRegistry {
  private readonly domains = new Map<string, RegisteredDomain>();
  /**
   * Per-domain discovery load-state, keyed by domain id. This is the per-scope
   * memoization that the capability loader reads/writes so a domain's
   * contributions are discovered + routed exactly once per project per scope.
   * Because the registry is itself per-`RunScope`, this state is per-scope too —
   * a second run for the same project re-loads into its own fresh registry.
   * This is the structural fix for the audit's F1 (sim's module-level
   * `scenariosLoadedFor`): the marker lives on a scope-owned object, not a module.
   */
  private readonly loadState = new Map<string, { loadedFor: string; errors: readonly string[] }>();
  private readonly logger: Logger;

  constructor(logger: Logger = defaultLogger) {
    this.logger = logger;
  }

  /** True when domain `domainId` has been discovery-loaded for `projectKey` in this scope. */
  isDomainLoaded(domainId: string, projectKey: string): boolean {
    return this.loadState.get(domainId)?.loadedFor === projectKey;
  }

  /** Record that `domainId` finished discovery-loading for `projectKey`, with any routing errors. */
  markDomainLoaded(domainId: string, projectKey: string, errors: readonly string[]): void {
    this.loadState.set(domainId, { loadedFor: projectKey, errors });
  }

  /** Routing errors recorded during the most recent load of `domainId` (empty if none / never loaded). */
  domainLoadErrors(domainId: string): readonly string[] {
    return this.loadState.get(domainId)?.errors ?? [];
  }

  /**
   * Register a capability domain + its owner's registrar. First-writer-wins
   * on duplicate domain id: a second registration of the same id is a no-op
   * (logged at debug) — mirrors the discovery walker's nearest-ancestor
   * dedup, so re-running discovery is idempotent.
   *
   * @param spec The domain description (id, owner, epoch, schema, kind).
   * @param registrar The owner callback invoked for a validated contribution.
   */
  registerDomain(spec: CapabilityDomainSpec, registrar: CapabilityRegistrar): void {
    if (this.domains.has(spec.id)) {
      this.logger.debug({
        evt: 'capability.domain.duplicate',
        module: 'core:plugins',
        domainId: spec.id,
        ownerToolId: spec.ownerToolId,
        msg: `capability domain '${spec.id}' already registered — keeping incumbent`,
      });
      return;
    }
    this.domains.set(spec.id, { spec, registrar });
    this.logger.debug({
      evt: 'capability.domain.registered',
      module: 'core:plugins',
      domainId: spec.id,
      ownerToolId: spec.ownerToolId,
      apiVersion: spec.apiVersion,
      contributionKind: spec.contributionKind,
    });
  }

  /**
   * Replace the registrar for an ALREADY-REGISTERED domain (Phase 4). The
   * manifest-read path ({@link registerCapabilityDomainsFromManifest})
   * registers each declared domain with a DEFERRED placeholder registrar that
   * throws on any contribution; once the owning tool's runtime module loads,
   * the host calls this to swap in the tool's REAL registrar.
   *
   * This is the deliberate complement to {@link registerDomain}'s
   * first-writer-wins: a domain's REGISTRAR is owner-replaceable (the owner
   * supplies it late), but its SPEC is not — the spec stays exactly as the
   * manifest declared it, so identity/epoch/schema cannot be overwritten by a
   * late registrar wiring. Only the owning tool should call this (the host
   * routes by `ownerToolId`); the spec is left untouched.
   *
   * @param domainId The domain whose registrar to replace.
   * @param registrar The owner's real registrar.
   * @throws {NotFoundError} (`CAPABILITY.DOMAIN.UNKNOWN`) when no domain
   *   `domainId` is registered — a registrar cannot be wired for a domain the
   *   host never declared (a manifest/tool-id mismatch).
   */
  setRegistrar(domainId: string, registrar: CapabilityRegistrar): void {
    const entry = this.domains.get(domainId);
    if (entry === undefined) {
      const known = [...this.domains.keys()];
      throw new UnknownCapabilityDomainError(
        `capability: cannot wire a registrar for undeclared domain '${domainId}'` +
          (known.length > 0 ? ` (known domains: ${known.join(', ')})` : ' (no domains declared)'),
        { domainId, knownDomains: known },
      );
    }
    // Replace the registrar; keep the manifest-declared spec verbatim.
    this.domains.set(domainId, { spec: entry.spec, registrar });
    this.logger.debug({
      evt: 'capability.domain.registrar_wired',
      module: 'core:plugins',
      domainId,
      ownerToolId: entry.spec.ownerToolId,
    });
  }

  /** Whether a domain with `domainId` is registered. */
  hasDomain(domainId: string): boolean {
    return this.domains.has(domainId);
  }

  /** Look up a registered domain's spec, or `undefined`. */
  getDomain(domainId: string): CapabilityDomainSpec | undefined {
    return this.domains.get(domainId)?.spec;
  }

  /** All registered domain specs (registration order). */
  listDomains(): readonly CapabilityDomainSpec[] {
    return [...this.domains.values()].map((d) => d.spec);
  }

  /**
   * Route a contribution to the owner of `domainId`. The host (a) confirms
   * the domain is declared, (b) validates `contribution` against the
   * domain's `contributionSchema`, then (c) hands it to the owner's
   * registrar. The host never interprets the contribution beyond the
   * schema check — the domain owner does.
   *
   * @throws {NotFoundError} (`CAPABILITY.DOMAIN.UNKNOWN`) when no domain
   *   `domainId` is registered.
   * @throws {ValidationError} (`CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH`)
   *   when the contribution fails the domain's schema check.
   */
  routeContribution(domainId: string, contribution: unknown): void {
    const entry = this.domains.get(domainId);
    if (entry === undefined) {
      const known = [...this.domains.keys()];
      throw new UnknownCapabilityDomainError(
        `capability: no domain '${domainId}' is declared` +
          (known.length > 0 ? ` (known domains: ${known.join(', ')})` : ' (no domains declared)'),
        { domainId, knownDomains: known },
      );
    }

    const verdict = validateContribution(entry.spec.contributionSchema, contribution);
    if (verdict !== true) {
      throw new CapabilitySchemaMismatchError(
        `capability: contribution to domain '${domainId}' (owner '${entry.spec.ownerToolId}') ` +
          `failed its schema: ${verdict}`,
        { domainId, ownerToolId: entry.spec.ownerToolId, diagnostic: verdict },
      );
    }

    entry.registrar(contribution);
  }
}

/**
 * Validate a contribution against a domain's `contributionSchema` WITHOUT
 * Zod. Three kinds of schema are accepted:
 *
 *   - a {@link CapabilityValidator} function — called; its `true | string`
 *     result IS the verdict.
 *   - a {@link StructuralContributionSchema} (`{ requiredKeys }`) — each
 *     listed key must be present (and non-`undefined`) on a record-shaped
 *     contribution.
 *   - `undefined` / anything else — treated as "no constraint": any
 *     contribution passes (a domain may opt out of host-side checking and
 *     validate entirely inside its own registrar).
 *
 * @returns `true` when the contribution satisfies the schema, otherwise a
 *   human-readable reason string (surfaced in the `ValidationError`).
 */
function validateContribution(schema: unknown, contribution: unknown): true | string {
  if (isCapabilityValidator(schema)) {
    return schema(contribution);
  }
  if (isStructuralContributionSchema(schema)) {
    if (typeof contribution !== 'object' || contribution === null) {
      return `expected an object contribution with keys [${schema.requiredKeys.join(', ')}], got ${contribution === null ? 'null' : typeof contribution}`;
    }
    const record = contribution as Record<string, unknown>;
    const missing = schema.requiredKeys.filter((k) => record[k] === undefined);
    if (missing.length > 0) {
      return `missing required key(s): ${missing.join(', ')}`;
    }
    return true;
  }
  // No declared constraint — defer all validation to the owner's registrar.
  return true;
}

/**
 * Augment the kernel scope with the capability registry slot. Unlike a
 * tool subscope (which a tool augments from ITS package), the capability
 * registry is a kernel concern, so core declares the slot itself here —
 * keeping the leaf `scope-types.ts` free of any edge back to this module
 * (which imports `run-scope.ts`). Optional + mutable: only the CLI
 * bootstrap (or a test) attaches it; a run without it reads `undefined`.
 */
declare module '../lib/scope-types.js' {
  interface ScopeContribution {
    /**
     * The host's per-run capability registry. Seeded by the CLI bootstrap
     * (Phase 4) and read via {@link currentCapabilityRegistry}. Absent on
     * a scope that never constructed one — consumers MUST null-check (the
     * reader throws a descriptive error in that case).
     */
    capabilities?: CapabilityRegistry;
  }
}

/** Construct a fresh capability registry for a single `RunScope`. */
export function createCapabilityRegistry(logger?: Logger): CapabilityRegistry {
  return new CapabilityRegistry(logger);
}

/**
 * Read the current scope's capability registry. Throws when no scope is
 * active or when the scope has no capability registry — both indicate the
 * caller is running outside the CLI's pre-action-hook (or a test fixture
 * forgot to construct + attach one).
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope carries no `capabilities` registry.
 */
export function currentCapabilityRegistry(): CapabilityRegistry {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'core: currentCapabilityRegistry() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: the pre-action-hook ' +
        'constructs the scope; tests: construct a RunScope, attach ' +
        'createCapabilityRegistry() to scope.capabilities, then runWithScope).',
    );
  }
  if (!scope.capabilities) {
    throw new Error(
      'core: scope.capabilities is missing. The CLI bootstrap must attach ' +
        'createCapabilityRegistry() to the scope before capability reads ' +
        '(production: the pre-action-hook seeds it; tests: assign ' +
        'scope.capabilities = createCapabilityRegistry()).',
    );
  }
  return scope.capabilities;
}

/**
 * Register every capability domain a manifest declares into the per-run
 * {@link CapabilityRegistry}, stamping `ownerToolId = manifest.stableId ??
 * manifest.id` on each (§5.3 / Task 2.2; ADR-0048 — the owner key must equal the
 * owning tool's `metadata.id`, which is the stable UUID for modern tools). This
 * is how `MARKER_KINDS` becomes a BOOTSTRAP DEFAULT:
 * the marker enum still seeds the discovery vocabulary, and a
 * manifest-declared domain EXTENDS that set — registered here without any
 * host-enum edit. Additive: a manifest with no `capabilities` registers
 * nothing.
 *
 * The owner-supplied registrar is NOT known at manifest-read time (the
 * tool's runtime module hasn't been imported), so this registers the
 * domain with a deferred-registrar placeholder that THROWS if a
 * contribution is routed before the owning tool wires its real registrar
 * (Phase 4). The host knows the domain EXISTS and who owns it; the owner
 * supplies the actual registrar when its module loads.
 *
 * Emits one structured `capability.domain.from_manifest` evt per domain so
 * a manifest-sourced domain is observable in structured logs (Task 2.2.3).
 *
 * @param manifest The validated manifest carrying the declarations.
 * @param registry The per-run capability registry to populate.
 * @returns The {@link CapabilityDomainSpec}s registered (owner-stamped).
 */
export function registerCapabilityDomainsFromManifest(
  manifest: ToolPluginManifest,
  registry: CapabilityRegistry,
): readonly CapabilityDomainSpec[] {
  const declarations = manifest.capabilities ?? [];
  const registered: CapabilityDomainSpec[] = [];
  for (const decl of declarations) {
    const spec: CapabilityDomainSpec = {
      id: decl.id,
      // ADR-0048: `ownerToolId` must equal the OWNING TOOL'S `metadata.id`, which
      // the capability loader filters on (`d.ownerToolId === owningTool.metadata.id`).
      // Post-ADR-0048 `metadata.id` is the stable UUID (== `manifest.stableId`) and
      // `manifest.id` is the human name (== `metadata.name`). Prefer the stableId so
      // the owner match works; fall back to the human `id` for legacy tools that
      // declare no `stableId` (where `metadata.id` is still the human id).
      ownerToolId: manifest.stableId ?? manifest.id,
      apiVersion: decl.apiVersion,
      contributionSchema: decl.contributionSchema,
      contributionKind: decl.contributionKind,
      // Carry the discovery descriptor onto the spec so the scope-owned capability
      // loader can drive the generic substrate for this domain (§5.3). Absent →
      // the domain auto-discovers nothing.
      ...(decl.discovery === undefined ? {} : { discovery: decl.discovery }),
    };
    registry.registerDomain(spec, makeDeferredRegistrar(spec));
    defaultLogger.info({
      evt: 'capability.domain.from_manifest',
      module: 'core:plugins',
      domainId: spec.id,
      ownerToolId: spec.ownerToolId,
      apiVersion: spec.apiVersion,
      contributionKind: spec.contributionKind,
    });
    registered.push(spec);
  }
  return registered;
}

/**
 * A placeholder registrar for a manifest-declared domain whose owning tool
 * has not wired its real registrar (Phase 4). Routing a contribution
 * before then is a programming error — the host knows the domain exists,
 * but no one can yet accept a contribution to it — so it throws a clear
 * diagnostic rather than silently dropping the contribution.
 *
 * @param spec The domain being registered with this placeholder.
 * @returns A {@link CapabilityRegistrar} that throws a {@link SystemError} on
 *   any invocation, until Phase 4 replaces it with the owning tool's real
 *   registrar.
 */
function makeDeferredRegistrar(spec: CapabilityDomainSpec): CapabilityRegistrar {
  return () => {
    // A SystemError (internal invariant violation): the domain exists but its
    // owning tool has not wired a real registrar yet, so a contribution arrived
    // before anyone can accept it. Self-documenting typed error — the throw is
    // intentional (placeholder until Phase 4 wires real registrars).
    throw new SystemError(
      `capability: domain '${spec.id}' (owner '${spec.ownerToolId}') was declared in a ` +
        `manifest but its owning tool has not registered a runtime registrar yet ` +
        `(Phase 4 wires real registrars). Cannot accept a contribution.`,
    );
  };
}
