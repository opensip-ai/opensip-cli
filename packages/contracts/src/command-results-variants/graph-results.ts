/**
 * Graph lookup result — portable match shape for `graph lookup --json`.
 *
 * Contracts sits below graph, so this mirrors the {@link FunctionOccurrence}
 * fields needed for machine output without importing graph types.
 */

/** One catalog function occurrence returned by `graph lookup`. */
export interface GraphLookupMatch {
  readonly bodyHash: string;
  readonly bodySize?: number;
  readonly simpleName: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly package?: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly kind: string;
  readonly params: readonly {
    readonly name: string;
    readonly optional: boolean;
    readonly rest: boolean;
  }[];
  readonly returnType: string | null;
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  /** Populated when the catalog has edge data; omitted on stage-1-only catalogs. */
  readonly calls?: readonly Record<string, unknown>[];
  readonly dependencies?: readonly Record<string, unknown>[];
}

/** Outcome of `opensip graph lookup <name>` on the `--json` path. */
export interface GraphLookupResult {
  type: 'graph-lookup';
  readonly name: string;
  readonly resolutionMode: 'exact' | 'fast';
  readonly matches: readonly GraphLookupMatch[];
}
