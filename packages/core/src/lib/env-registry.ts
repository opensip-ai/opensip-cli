/**
 * EnvRegistry — a governed registry of environment variables (north-star §5.12,
 * launch).
 *
 * Environment variables are a user-facing configuration surface, but today they
 * are read inline (`process.env.X`) across ~half a dozen packages with no
 * canonical name, no alias policy, no coercion, no documentation, and no
 * deprecation path. `EnvRegistry` is the single seam every env read flows through:
 * a tool/host declares an {@link EnvVarSpec} (canonical name, aliases, coercion,
 * default, docs, deprecation), and all reads go through {@link EnvRegistry.get}.
 * The `env-via-registry` guardrail (launch) then fails CI on any raw `process.env`
 * access outside this module.
 *
 * Layering / state: this is a KERNEL observability primitive, beside `logger` and
 * `ids`. Reading `process.env` HERE is the one sanctioned site — the registry IS
 * the seam the guardrail points everything else at. The DEFINITION table a caller
 * passes in is an immutable constant; that does not violate the no-module-
 * singleton rule (which targets mutable per-run state), and it is exactly why the
 * registry can serve the pre-scope readers (terminal theme, graph heap-preflight)
 * that run before `RunScope` exists — they read through a static instance over the
 * immutable table, not a scope-bound one.
 *
 * Pure read model: `get` resolves canonical → aliases in declaration order,
 * coerces, and applies the default; it never mutates `process.env`. Deprecation is
 * surfaced (not logged here — core stays log-light) so the composing host can emit
 * a structured `cli.env.read_deprecated` event when a deprecated alias is hit.
 */

/**
 * A deprecation note on an env var or one of its aliases. `since` is the release
 * the deprecation began; `use` names the canonical replacement to migrate to.
 */
export interface EnvDeprecation {
  readonly since: string;
  readonly use?: string;
}

/**
 * Declarative description of one environment variable.
 *
 * @typeParam T - the coerced value type (defaults to `string` — the raw value).
 */
export interface EnvVarSpec<T = string> {
  /** Canonical, documented name (e.g. `OPENSIP_NO_UPDATE`). */
  readonly canonical: string;
  /**
   * Accepted aliases, in resolution order AFTER the canonical name (e.g. the npm
   * convention `NO_UPDATE_NOTIFIER`). A hit on an alias marked via
   * {@link EnvVarSpec.deprecated} is reported by {@link EnvRegistry.get} so the
   * caller can warn.
   */
  readonly aliases?: readonly string[];
  /**
   * Pure coercion from the raw string to `T` (e.g. `(raw) => raw === '1'`).
   * Omitted ⇒ identity (the value type is `string`). Never reads other env.
   */
  readonly coerce?: (raw: string) => T;
  /** Value when neither canonical nor any alias is set. */
  readonly default?: T;
  /** One-line documentation surfaced in the generated env-surface reference. */
  readonly docs: string;
  /** Deprecation policy for the canonical name (alias-level handled at read). */
  readonly deprecated?: EnvDeprecation;
}

/**
 * Result of an {@link EnvRegistry.get} read. `value` is the coerced value (or the
 * spec default, or `undefined`); `source` names which key supplied it; and
 * `deprecated` carries the note when the resolved key (canonical or alias) is
 * deprecated, so the caller can emit a structured warning.
 */
export interface EnvReadResult<T> {
  readonly value: T | undefined;
  readonly source: 'canonical' | 'alias' | 'default' | 'unset';
  readonly deprecated?: EnvDeprecation;
}

/**
 * The composed registry. Construct once (host) over the full {@link EnvVarSpec}
 * set; read via {@link EnvRegistry.get} (coerced value only) or
 * {@link EnvRegistry.read} (value + source + deprecation). The pre-scope static
 * accessor (terminal theme, heap-preflight) constructs its own instance over the
 * shared immutable host table.
 */
export class EnvRegistry {
  private readonly byCanonical = new Map<string, EnvVarSpec<unknown>>();

  constructor(specs: readonly EnvVarSpec<unknown>[]) {
    for (const spec of specs) {
      this.byCanonical.set(spec.canonical, spec);
    }
  }

  /** True when this canonical name is registered. */
  has(canonical: string): boolean {
    return this.byCanonical.has(canonical);
  }

  /** Every registered spec, for the generated env-surface reference doc. */
  describe(): readonly EnvVarSpec<unknown>[] {
    return [...this.byCanonical.values()];
  }

  /**
   * Resolve a variable to its coerced value: canonical first, then aliases in
   * order, else the spec default, else `undefined`. The convenience form of
   * {@link EnvRegistry.read} when the caller does not need source/deprecation.
   */
  get<T = string>(canonical: string): T | undefined {
    return this.read<T>(canonical).value;
  }

  /**
   * Resolve a variable to its value PLUS provenance. Reads `process.env` for the
   * canonical name, then each alias in declaration order; the first set key wins.
   * A deprecation note is attached when the resolved key is deprecated (the
   * canonical's own `deprecated`, or — for an alias hit — the canonical
   * `deprecated` if present, since an alias existing at all is the migration
   * signal). Unknown canonical names throw: a typo in a host spec is a bug, not a
   * silent `undefined`.
   *
   * @throws {Error} When `canonical` is not a registered {@link EnvVarSpec} — a
   *   host-spec typo surfaces loudly here rather than as a silent `undefined`.
   */
  read<T = string>(canonical: string): EnvReadResult<T> {
    const spec = this.byCanonical.get(canonical) as EnvVarSpec<T> | undefined;
    if (spec === undefined) {
      throw new Error(
        `EnvRegistry: unknown variable '${canonical}' — declare an EnvVarSpec before reading it.`,
      );
    }

    const coerce = (raw: string): T => (spec.coerce ? spec.coerce(raw) : (raw as unknown as T));

    const canonicalRaw = process.env[spec.canonical];
    if (canonicalRaw !== undefined) {
      return { value: coerce(canonicalRaw), source: 'canonical', deprecated: spec.deprecated };
    }

    for (const alias of spec.aliases ?? []) {
      const aliasRaw = process.env[alias];
      if (aliasRaw !== undefined) {
        return { value: coerce(aliasRaw), source: 'alias', deprecated: spec.deprecated };
      }
    }

    if (spec.default !== undefined) {
      return { value: spec.default, source: 'default' };
    }

    return { value: undefined, source: 'unset' };
  }
}
