/**
 * declaration — the contract a tool offers to the configuration layer.
 *
 * Each tool contributes a {@link ToolConfigDeclaration}: a namespace (its
 * top-level key in `opensip-cli.config.yml`), a Zod schema describing that
 * namespace's block, optional defaults, and optional environment-variable
 * bindings. The host composes the registered declarations into one strict
 * whole-document schema (see {@link ./composer}) and resolves precedence across
 * flags / env / file / defaults (see {@link ./precedence}).
 *
 * Nothing here imports a tool; the declaration is a pure data contract the
 * tools hand to the composition root (wired in Phase 4).
 */

import type { ZodType } from 'zod';

/**
 * Coercion applied to a raw environment-variable string before it is merged
 * into the resolved config.
 *
 *   - `string`  — passed through verbatim (the default).
 *   - `number`  — parsed with `Number(...)`; a non-finite result is dropped.
 *   - `boolean` — `'true'`/`'1'` → true, `'false'`/`'0'` → false (case-insensitive);
 *                 anything else is dropped.
 */
export type EnvBindingType = 'string' | 'number' | 'boolean';

/**
 * Binds one environment variable to one config key within a namespace.
 *
 * The precedence resolver reads `process.env[envVar]` (supplied as the `env`
 * map), coerces it per `type`, and writes it onto the namespace's resolved
 * object under `key` — but only if no higher-precedence source (a flag) already
 * set it.
 */
export interface EnvBindingDeclaration {
  /** The environment variable name, e.g. `OPENSIP_FIT_FAIL_ON_ERRORS`. */
  readonly envVar: string;
  /** The config key within the owning namespace this variable populates. */
  readonly key: string;
  /** How the raw string is coerced before merge. Defaults to `'string'`. */
  readonly type?: EnvBindingType;
}

/**
 * A tool's contribution to the composed configuration document.
 *
 * `namespace` is the tool's top-level key (e.g. `fitness`, `graph`,
 * `simulation`); `schema` validates that namespace's block. The composer makes
 * each namespace schema `.strict()` so a typo inside a known namespace is
 * rejected, while tolerating unclaimed top-level keys for forward compatibility.
 */
export interface ToolConfigDeclaration {
  /** Top-level config key owned by this tool. */
  readonly namespace: string;
  /** Zod schema validating the namespace's block. */
  readonly schema: ZodType;
  /** Optional defaults for the namespace, used as the lowest-precedence source. */
  readonly defaults?: unknown;
  /** Optional environment-variable bindings for keys in this namespace. */
  readonly env?: readonly EnvBindingDeclaration[];
}
