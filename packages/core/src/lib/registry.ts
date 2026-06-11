// @fitness-ignore-file toctou-race-condition -- registry register() reads byName.get then byName.set on local Maps owned by the Registry instance; entirely synchronous, no async gap, safe in single-threaded Node.js
/**
 * @fileoverview Generic registry — the single base class for every
 * registry in the workspace.
 *
 * Replaces the ten registry classes catalogued in
 * `docs/plans/ready/architecture-runscope-and-registry/phase-0-audit-and-design.md`.
 *
 * Owns: by-id Map, by-name Map, the closed `DuplicatePolicy` branch,
 * the orthogonal `nameCollisionMode` guard, and the structured-event
 * emitter. Domain-specific indices (extension, alias, slug, scope)
 * live in thin subclasses or alongside; the base must stay
 * tool-agnostic.
 */

import { ValidationError } from './errors.js';
import { logger as defaultLogger, type Logger } from './logger.js';

/**
 * Closed union of duplicate-handling policies.
 *
 * - `warn-first-wins` — log warning, keep incumbent (ToolRegistry,
 *   LanguageRegistry, graph rules).
 * - `throw` — throw `ValidationError` on duplicate id/name
 *   (FitnessRecipeRegistry, SimulationRecipeRegistry).
 * - `overwrite` — replace incumbent silently (graph lang-adapter
 *   registry).
 * - `silent-skip` — ignore the second registration (CheckRegistry,
 *   TargetRegistry, scenarios).
 * - `allow-internal` — first call bypasses the guard; subsequent
 *   duplicates throw unless `{ internal: true }` is passed. Reserved
 *   for "register builtins without flag" patterns; current consumers
 *   use per-call `{ internal: true }` against a strict default.
 */
export type DuplicatePolicy =
  | 'warn-first-wins'
  | 'throw'
  | 'overwrite'
  | 'silent-skip'
  | 'allow-internal';

/** Minimum shape any registry item must satisfy. */
export interface Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

/** Constructor options for `Registry<T>`. */
export interface RegistryOptions {
  /** Human-readable module label used in structured events / errors. */
  readonly module: string;
  readonly duplicatePolicy: DuplicatePolicy;
  /** Event prefix — events emit as `<prefix>.duplicate` etc. */
  readonly evtPrefix: string;
  /** Validation-error code surfaced when policy === 'throw'. */
  readonly validationCode?: string;
  /**
   * Name-collision policy (orthogonal to `duplicatePolicy`). When set
   * to `'throw'`, registering an item whose `name` is already used by
   * a DIFFERENT id throws a `ValidationError`. Default `'allow'`
   * falls through to `duplicatePolicy`.
   */
  readonly nameCollisionMode?: 'allow' | 'throw';
  /** Logger override — defaults to the workspace singleton. */
  readonly logger?: Logger;
}

/** Per-call options. */
export interface RegisterCallOptions {
  /**
   * Bypass the duplicate guard for this single call. Use for
   * built-in seeding. Ignored if no duplicate condition is reached.
   */
  readonly internal?: boolean;
  /**
   * Source package id — included in structured events for
   * third-party warnings.
   */
  readonly sourcePackage?: string;
}

/**
 * Generic id+name+tag registry with a closed duplicate-handling
 * policy and structured-event emission. Use composition (one
 * `Registry<T>` instance per registry) or inheritance (extend
 * the class) — both are supported.
 */
export class Registry<T extends Registerable> {
  private readonly byId = new Map<string, T>();
  private readonly byName = new Map<string, T>();
  private readonly module: string;
  private readonly duplicatePolicy: DuplicatePolicy;
  private readonly evtPrefix: string;
  private readonly validationCode: string | undefined;
  private readonly nameCollisionMode: 'allow' | 'throw';
  private readonly logger: Logger;

  constructor(opts: RegistryOptions) {
    this.module = opts.module;
    this.duplicatePolicy = opts.duplicatePolicy;
    this.evtPrefix = opts.evtPrefix;
    this.validationCode = opts.validationCode;
    this.nameCollisionMode = opts.nameCollisionMode ?? 'allow';
    this.logger = opts.logger ?? defaultLogger;
  }

  register(item: T, callOpts: RegisterCallOptions = {}): void {
    const { byId, byName } = this;
    const internal = callOpts.internal === true;

    // Name-collision guard (orthogonal to duplicate policy). Only
    // fires when the incumbent has a DIFFERENT id from `item.id`
    // (same-id same-name is handled by the duplicate-policy branch).
    const nameIncumbent = byName.get(item.name);
    if (
      nameIncumbent &&
      nameIncumbent.id !== item.id &&
      this.nameCollisionMode === 'throw' &&
      !internal
    ) {
      // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
      throw new ValidationError(
        `${this.module} registry: name collision — '${item.name}' is already registered with id '${nameIncumbent.id}', cannot register id '${item.id}' with the same name`,
        { code: this.validationCode ?? 'VALIDATION.REGISTRY.NAME_COLLISION' },
      );
    }

    // Duplicate-condition detection: same id, OR same name with a
    // different id (regardless of nameCollisionMode, because we
    // can't have two entries sharing the byName slot).
    const idIncumbent = byId.get(item.id);
    const isDup =
      idIncumbent !== undefined || (nameIncumbent !== undefined && nameIncumbent.id !== item.id);

    if (isDup && !internal) {
      switch (this.duplicatePolicy) {
        case 'silent-skip': {
          return;
        }
        case 'warn-first-wins': {
          this.logger.warn({
            evt: `${this.evtPrefix}.duplicate`,
            module: this.module,
            id: item.id,
            name: item.name,
            sourcePackage: callOpts.sourcePackage,
            msg: `${item.id} already registered — keeping incumbent`,
          });
          return;
        }
        case 'throw': {
          // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
          throw new ValidationError(
            `${this.module}: '${item.name}' (${item.id}) already registered`,
            { code: this.validationCode ?? 'VALIDATION.REGISTRY.DUPLICATE' },
          );
        }
        case 'overwrite': {
          // Drop stale mappings before re-insert so {byId, byName}
          // stay consistent (e.g. overwrite-by-id when the new
          // entry has a different name).
          if (idIncumbent && idIncumbent.name !== item.name) {
            byName.delete(idIncumbent.name);
          }
          if (nameIncumbent && nameIncumbent.id !== item.id) {
            byId.delete(nameIncumbent.id);
          }
          break;
        }
        case 'allow-internal': {
          // First non-internal write was allowed (it landed without
          // a dup condition). Subsequent duplicates throw unless
          // `{ internal: true }` is passed.
          // @fitness-ignore-next-line result-pattern-consistency -- registration guard, throw is appropriate
          throw new ValidationError(
            `${this.module}: '${item.name}' (${item.id}) already registered (allow-internal: only the first write is permitted without { internal: true })`,
            { code: this.validationCode ?? 'VALIDATION.REGISTRY.DUPLICATE' },
          );
        }
      }
    }

    byId.set(item.id, item);
    byName.set(item.name, item);
  }

  registerAll(items: readonly T[], callOpts: RegisterCallOptions = {}): void {
    for (const item of items) this.register(item, callOpts);
  }

  get(idOrName: string): T | undefined {
    return this.byId.get(idOrName) ?? this.byName.get(idOrName);
  }

  getById(id: string): T | undefined {
    return this.byId.get(id);
  }

  getByName(name: string): T | undefined {
    return this.byName.get(name);
  }

  has(idOrName: string): boolean {
    return this.byId.has(idOrName) || this.byName.has(idOrName);
  }

  getAll(): readonly T[] {
    return [...this.byId.values()];
  }

  getByTag(tag: string): readonly T[] {
    return this.getAll().filter((item) => item.tags?.includes(tag));
  }

  remove(id: string): boolean {
    const item = this.byId.get(id);
    if (!item) return false;
    this.byId.delete(id);
    this.byName.delete(item.name);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.byName.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
