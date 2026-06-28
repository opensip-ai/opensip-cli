/**
 * Symbol + freshness DTOs for the MCP read ports (ADR-0084).
 *
 * These are the *only* graph shapes that cross the {@link GraphReadPort}
 * boundary — the SQLite impl never leaks `Catalog` / `Indexes` to handlers
 * (SaaS parity: an alternate storage backend can substitute behind the same
 * narrow port). DTOs carry symbol METADATA only (qualified name, path, span,
 * kind, visibility, `bodyHash`) — never raw file bodies (`bodyHash` is a hash,
 * not source).
 */

/**
 * A single resolved symbol occurrence. `symbolId` is the stable identity
 * downstream tools accept (never a bare name): `"${filePath}:${line}:${column}"`.
 */
export interface SymbolRef {
  /** Stable identity: `"${filePath}:${line}:${column}"`. */
  readonly symbolId: string;
  /** sha256(normalized body) — the graph's content identifier. */
  readonly bodyHash: string;
  /** Human-display qualified name (e.g. `"fitness/engine/src/gate.saveBaseline"`). */
  readonly qualifiedName: string;
  /** Project-relative path. */
  readonly filePath: string;
  /** 1-based line where the declaration begins. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** Function kind (`'function'`, `'method'`, `'arrow'`, …). */
  readonly kind: string;
  /** Visibility (`'exported'`, `'private'`, …). */
  readonly visibility: string;
}

/**
 * Freshness verdict for the served catalog generation. Derived from the graph
 * engine's `classifyCatalog` (never a filesystem mtime heuristic outside the
 * engine). A missing catalog ⇒ `fresh: false` with empty data — never a silent
 * auto-build.
 */
export interface Freshness {
  /** `true` only when the persisted catalog matches the current file set. */
  readonly fresh: boolean;
  /** ISO timestamp the served generation was built at (absent when missing). */
  readonly builtAt?: string;
  /** Why the catalog is stale/missing (`'missing'`, `'language-changed'`, …). */
  readonly reason?: string;
}

/**
 * The shared graph-read envelope: every {@link GraphReadPort} read carries
 * `{ data, freshness }` so an agent always sees whether the answer came from a
 * fresh, stale, or missing catalog. `truncated` is set when a bounded walk or
 * search hit its node/result cap.
 */
export interface McpToolResult<T> {
  readonly data: T;
  readonly freshness: Freshness;
  readonly truncated?: boolean;
}
