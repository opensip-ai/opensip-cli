/**
 * Canonical first-party tool id registry.
 *
 * Two distinct forms exist for historical reasons:
 *
 *   - **Long form** (`'fitness' | 'simulation' | 'graph'`) — used by
 *     `Tool.metadata.id` and most human-facing copy. Each tool
 *     self-identifies with this form.
 *
 *   - **Short form** (`'fit' | 'sim' | 'graph'`) — used as the storage
 *     discriminator in `StoredSession.tool`, `SignalEnvelope.tool`,
 *     path-domain names (`<project>/opensip-tools/fit/`,
 *     `<project>/opensip-tools/sim/`), and CLI subcommand names. SQL
 *     rows, generated dashboards, and on-disk layout all use it.
 *
 * Prior to audit-round-3 Finding H, the same literal union appeared
 * inline in 5+ places (`StoredSession.tool`, the JSON output `tool`,
 * `PathDomain`, `VALID_TOOLS` set, etc.) with no shared source of
 * truth. Adding a 4th first-party tool risked editing N − 1 sites and
 * silently passing tests until a SQL row carried an unknown
 * discriminator at runtime.
 *
 * Third-party tools (registered via `discoverToolPackages`) MAY use
 * any short / long id. The unions below are first-party-only; the
 * persistence + path layers do NOT today store rows for third-party
 * tools (they'd need an extension).
 */

/** First-party canonical short ids — storage/output discriminators. */
export const TOOL_SHORT_IDS = ['fit', 'sim', 'graph'] as const;

/** First-party short id type (storage discriminator). */
export type ToolShortId = (typeof TOOL_SHORT_IDS)[number];

/** First-party canonical long ids — `Tool.metadata.id` values. */
export const TOOL_LONG_IDS = ['fitness', 'simulation', 'graph'] as const;

/** First-party long id type (Tool metadata). */
export type ToolLongId = (typeof TOOL_LONG_IDS)[number];

/** Canonical long → short mapping for the first-party tools. */
export const TOOL_LONG_TO_SHORT = {
  fitness: 'fit',
  simulation: 'sim',
  graph: 'graph',
} as const satisfies Record<ToolLongId, ToolShortId>;

/** Canonical short → long mapping (inverse of `TOOL_LONG_TO_SHORT`). */
export const TOOL_SHORT_TO_LONG = {
  fit: 'fitness',
  sim: 'simulation',
  graph: 'graph',
} as const satisfies Record<ToolShortId, ToolLongId>;

/**
 * Runtime predicate for short ids. Use at trust boundaries where a
 * value crosses from `unknown` into the typed domain — most notably
 * `SessionRepo.hydrateSession` validating the SQLite `tool` column,
 * which has no CHECK constraint.
 */
export function isToolShortId(value: unknown): value is ToolShortId {
  return typeof value === 'string' && (TOOL_SHORT_IDS as readonly string[]).includes(value);
}

/**
 * Runtime predicate for long ids. Use where a value claims to be a
 * `Tool.metadata.id` for a first-party tool (e.g. cross-checking the
 * long form a tool reported against the canonical mapping).
 */
export function isToolLongId(value: unknown): value is ToolLongId {
  return typeof value === 'string' && (TOOL_LONG_IDS as readonly string[]).includes(value);
}
