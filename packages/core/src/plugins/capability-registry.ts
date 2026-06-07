/**
 * @fileoverview Scope-owned capability registry (release 2.10.0, §5.3).
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
  UnknownCapabilityDomainError,
} from '../lib/errors.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { currentScope } from '../lib/run-scope.js';
import {
  isCapabilityValidator,
  isStructuralContributionSchema,
  type CapabilityDomainSpec,
} from '../tools/capability.js';

/**
 * The owner-supplied callback the host invokes once a contribution has
 * passed the domain's schema check. The host hands the validated
 * contribution straight through — it never inspects the contribution's
 * domain-specific meaning. The registrar performs the actual registration
 * into the owning tool's own registry (a `CheckRegistry`, scenario
 * `Registry`, graph-adapter registry, …).
 */
export type CapabilityRegistrar = (contribution: unknown) => void;

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
  private readonly logger: Logger;

  constructor(logger: Logger = defaultLogger) {
    this.logger = logger;
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
