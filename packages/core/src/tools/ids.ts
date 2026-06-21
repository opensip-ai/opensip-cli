/**
 * Canonical tool id registry.
 *
 * Two distinct forms exist for historical reasons:
 *
 *   - **Long form** (`'fitness' | 'simulation' | 'graph'`) — used by
 *     `Tool.metadata.id` and most human-facing copy. Each tool
 *     self-identifies with this form.
 *
 *   - **Short form** — used as the storage discriminator in
 *     `StoredSession.tool`, `SignalEnvelope.tool`, path-domain names
 *     (`<project>/opensip-cli/fit/`, `<project>/opensip-cli/sim/`),
 *     and CLI subcommand names. SQL rows, generated dashboards, and
 *     on-disk layout all use it.
 *
 * ## Open vs. bundled (M3)
 *
 * The short id is the **session/persistence discriminant**. Before M3
 * it was a CLOSED 3-literal union (`'fit' | 'sim' | 'graph'`), which
 * meant a registered third-party tool got COMMAND parity (it could
 * mount commands) but NOT session parity — its runs could be *saved*
 * (the SQLite `tool` column is plain text), yet failed to *hydrate*
 * because `SessionRepo` rejected any non-bundled discriminant.
 *
 * The discriminant is therefore now an OPEN type ({@link ToolShortId} =
 * `string`): the persistence/session seam accepts ANY registered tool's
 * id and validates it at runtime against the live tool registry
 * ({@link isRegisteredToolId}) rather than a compile-time closed set.
 *
 * The bundled three remain a closed literal union ({@link
 * BundledToolShortId}) for genuinely first-party, type-safe internal
 * use — most importantly the {@link TOOL_LONG_TO_SHORT} /
 * {@link TOOL_SHORT_TO_LONG} maps and the {@link isBundledToolShortId}
 * guard that narrows a value to a key of those maps. Widening those to
 * `string` would be wrong: they only know fit/sim/graph.
 *
 * Prior to audit-round-3 Finding H, the same literal union appeared
 * inline in 5+ places with no shared source of truth; centralizing it
 * here is what made the M3 widening a single-seam change.
 *
 * This module is a LEAF: pure id constants, types, and structural
 * guards with no tool-runtime imports. The registry-validated guard
 * (`isRegisteredToolId`) that needs the live {@link ToolRegistry} lives
 * in the sibling `registered-ids.ts` so this stays cycle-free
 * (`tool-sessions.ts` imports `ToolShortId` from here).
 */

/** Bundled (first-party) canonical short ids. */
export const TOOL_SHORT_IDS = ['fit', 'sim', 'graph'] as const;

/**
 * Bundled (first-party) short id literal union — the type-safe set for
 * internal use (mapping keys, exhaustive switches over the three). NOT
 * the storage discriminant; for that use the open {@link ToolShortId}.
 */
export type BundledToolShortId = (typeof TOOL_SHORT_IDS)[number];

/**
 * OPEN tool short id — the session/persistence/path discriminant.
 *
 * Any registered tool (bundled or third-party) self-declares one of
 * these as its `ToolSessionContribution.tool` / `SignalEnvelope.tool`;
 * the host persists it verbatim and validates it at trust boundaries
 * with {@link isRegisteredToolId} (registry-validated) or, where the
 * registry is unavailable (the tool-vocabulary-free datastore layer),
 * the structural {@link isToolShortId}.
 *
 * The codebase has no brand helper, so this is a plain `string` alias;
 * the name documents intent at the seam.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- intentional named seam alias (M3): the storage/session tool discriminant is deliberately open `string`; the name documents the boundary and keeps the dozens of `ToolShortId` annotations meaningful (mirrors the cli-context.ts seam-alias precedent).
export type ToolShortId = string;

/** First-party canonical long ids — `Tool.metadata.id` values. */
export const TOOL_LONG_IDS = ['fitness', 'simulation', 'graph'] as const;

/** First-party long id type (Tool metadata). */
export type ToolLongId = (typeof TOOL_LONG_IDS)[number];

/** Canonical long → short mapping for the bundled tools. */
export const TOOL_LONG_TO_SHORT = {
  fitness: 'fit',
  simulation: 'sim',
  graph: 'graph',
} as const satisfies Record<ToolLongId, BundledToolShortId>;

/** Canonical short → long mapping (inverse of `TOOL_LONG_TO_SHORT`). */
export const TOOL_SHORT_TO_LONG = {
  fit: 'fitness',
  sim: 'simulation',
  graph: 'graph',
} as const satisfies Record<BundledToolShortId, ToolLongId>;

/**
 * Runtime predicate for the BUNDLED short ids — narrows a value to a key
 * of {@link TOOL_SHORT_TO_LONG}. Use when a value must be one of the
 * first-party three (e.g. indexing the bundled-only long/short maps in
 * `tools data-purge`). For the open storage discriminant use
 * {@link isToolShortId} (structural) or {@link isRegisteredToolId}
 * (registry-validated).
 */
export function isBundledToolShortId(value: unknown): value is BundledToolShortId {
  return typeof value === 'string' && (TOOL_SHORT_IDS as readonly string[]).includes(value);
}

/**
 * Structural predicate for the OPEN tool short id (the storage
 * discriminant). Use at trust boundaries where a value crosses from
 * `unknown` into the typed domain but the live tool registry is NOT
 * available — most notably `SessionRepo.buildSession` validating the
 * SQLite `tool` column (which has no CHECK constraint). The datastore
 * layer holds zero tool vocabulary, so it can only assert the shape (a
 * non-empty string), not membership; the registry-validated
 * {@link isRegisteredToolId} is the stronger boundary check the host
 * applies where the registry IS in scope.
 */
export function isToolShortId(value: unknown): value is ToolShortId {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Runtime predicate for long ids. Use where a value claims to be a
 * `Tool.metadata.id` for a first-party tool (e.g. cross-checking the
 * long form a tool reported against the canonical mapping).
 */
export function isToolLongId(value: unknown): value is ToolLongId {
  return typeof value === 'string' && (TOOL_LONG_IDS as readonly string[]).includes(value);
}
