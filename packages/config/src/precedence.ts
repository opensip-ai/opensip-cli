/**
 * precedence — resolves the effective configuration from layered sources.
 *
 * Precedence, highest-wins, per namespace/key:
 *
 *   flag > env > file > defaults
 *
 *   - `defaults` — each declaration's `defaults` (lowest precedence).
 *   - `file`     — the validated `opensip-tools.config.yml` document.
 *   - `env`      — values read from environment variables via each
 *     declaration's `env` bindings, coerced per binding `type`.
 *   - `flags`    — CLI-supplied overrides (highest precedence).
 *
 * Resolution is per-key within each namespace: a flag for `fitness.recipe` does
 * not clobber a file-supplied `fitness.failOnErrors`. Sources are plain
 * `namespace -> { key -> value }` maps; the resolver deep-merges them in
 * precedence order.
 */

import type {
  EnvBindingDeclaration,
  EnvBindingType,
  ToolConfigDeclaration,
} from './declaration.js';

/** A `namespace -> { key -> value }` map for one precedence source. */
type NamespaceMap = Record<string, Record<string, unknown>>;

/** Inputs to {@link resolveConfig}. All sources are optional. */
export interface ResolveConfigInput {
  /** The tool declarations (supply `defaults` + `env` bindings). */
  readonly declarations: readonly ToolConfigDeclaration[];
  /** Highest-precedence overrides, e.g. parsed CLI flags. */
  readonly flags?: NamespaceMap;
  /** Raw environment map, typically `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The validated config file document (namespace blocks). */
  readonly file?: NamespaceMap;
}

/** The resolved configuration: `namespace -> { key -> value }`. */
export type ResolvedConfig = Record<string, Record<string, unknown>>;

/** Accepted truthy / falsy spellings for a `boolean` env binding (case-insensitive). */
const BOOLEAN_TRUE = new Set(['true', '1']);
const BOOLEAN_FALSE = new Set(['false', '0']);

/** Coerce a raw env string for a `boolean` binding; undefined drops an unrecognised value. */
function coerceBoolean(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(v)) return true;
  if (BOOLEAN_FALSE.has(v)) return false;
  return undefined;
}

/** Coerce a raw env string per its binding `type`; return undefined to drop it. */
function coerceEnvValue(raw: string, type: EnvBindingType | undefined): unknown {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      return coerceBoolean(raw);
    }
    case 'string':
    case undefined: {
      return raw;
    }
  }
}

/** Project a declaration's env bindings into a `{ key -> coerced value }` map. */
function readEnvBindings(
  bindings: readonly EnvBindingDeclaration[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!bindings) return out;
  for (const binding of bindings) {
    const raw = env[binding.envVar];
    if (raw === undefined) continue;
    const coerced = coerceEnvValue(raw, binding.type);
    if (coerced !== undefined) out[binding.key] = coerced;
  }
  return out;
}

/** A plain object check that treats arrays and null as non-objects. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve the effective config by merging sources in precedence order.
 *
 * Only namespaces that appear in `declarations` are resolved (unclaimed
 * top-level keys are not this resolver's concern — they pass through the
 * composer untouched). For each declared namespace the resolver merges, in
 * ascending precedence: declaration defaults → file block → env bindings →
 * flags. A later source's key overrides an earlier source's same key; keys only
 * present in an earlier source are preserved.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const { declarations, flags = {}, env = {}, file = {} } = input;
  const resolved: ResolvedConfig = {};

  for (const decl of declarations) {
    const ns = decl.namespace;
    const merged: Record<string, unknown> = {};

    // 1. defaults (lowest)
    if (isPlainObject(decl.defaults)) {
      Object.assign(merged, decl.defaults);
    }
    // 2. file
    if (isPlainObject(file[ns])) {
      Object.assign(merged, file[ns]);
    }
    // 3. env bindings
    Object.assign(merged, readEnvBindings(decl.env, env));
    // 4. flags (highest)
    if (isPlainObject(flags[ns])) {
      Object.assign(merged, flags[ns]);
    }

    resolved[ns] = merged;
  }

  return resolved;
}
