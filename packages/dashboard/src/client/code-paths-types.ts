/**
 * Structural types for the Code Paths client modules (L4 migration).
 *
 * The browser bundle reads the graph catalog purely by JSON shape — the real
 * `GraphCatalog`/`GraphFunctionOccurrence` contracts live in
 * `@opensip-cli/contracts`, but the client `tsconfig` runs with `types: []` and
 * the bundle must stay decoupled from the engine's runtime types (the
 * views-disjoint / no-graph-import architecture rule). So these are minimal
 * structural mirrors — only the fields the client code actually touches — kept
 * deliberately loose (optional, `unknown` for opaque payloads) to match what the
 * inlined JSON can carry across catalog versions.
 *
 * This is a type-only module (no runtime exports); esbuild erases it entirely.
 */

/** One function occurrence (a graph node), read structurally from the catalog. */
export interface OccLike {
  bodyHash: string;
  simpleName?: string;
  qualifiedName?: string;
  filePath?: string;
  package?: string;
  line?: number;
  endLine?: number;
  column?: number;
  kind?: string;
  visibility?: string;
  inTestFile?: boolean;
  returnType?: string | null;
  params?: readonly { name?: string; rest?: boolean; optional?: boolean }[];
  calls?: readonly CallEdgeLike[];
}

/** A call edge: one or more resolved target bodyHashes. */
export interface CallEdgeLike {
  to?: readonly string[];
  line?: number;
  column?: number;
}

/** The inline graph catalog blob, read structurally. */
export interface CatalogLike {
  functions?: Record<string, OccLike[]>;
  cacheKey?: string;
  builtAt?: string;
  resolutionMode?: string;
  [key: string]: unknown;
}

/** The adjacency/index maps `buildIndexes` produces and the views consume. */
export interface IndexesLike {
  byBodyHash: Map<string, OccLike>;
  occurrencesByHash: Map<string, OccLike[]>;
  bySimpleName: Map<string, string[]>;
  callees: Map<string, string[]>;
  callers: Map<string, string[]>;
}

/** The default, non-interactive filter the Functions table reads via `passesFilter`. */
export interface FilterStateLike {
  packages: Set<string>;
  kinds: Set<string>;
  includeTests: boolean;
}

/** A help block on a registered view (rendered by the help drawer). */
export interface ViewHelp {
  title?: string;
  sections?: readonly { heading: string; body: string }[];
}

/** A registered Explore view descriptor (each `view-*` emitter pushes one). */
export interface ViewLike {
  id: string;
  label: string;
  help?: ViewHelp;
  render: (
    container: HTMLElement,
    catalog: CatalogLike | null,
    indexes: IndexesLike,
    filterState: FilterStateLike,
  ) => void;
  onActivate?: () => void;
}
