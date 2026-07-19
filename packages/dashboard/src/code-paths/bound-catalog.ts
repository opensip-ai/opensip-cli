/**
 * bound-catalog — project the graph catalog down to what the report actually
 * renders, and bound what remains.
 *
 * The report used to inline the ENTIRE persisted catalog contract. On this
 * repository (17.5k functions) that produced a **293 MB** `latest.html`: one
 * 306 MB `<script>` of which the browser reads a small fraction. It could not
 * be opened, could not be attached to a PR, and took the dashboard test suite
 * down with it by exhausting the jsdom heap. An empty report is ~700 KB.
 *
 * Two independent problems, fixed in order:
 *
 * 1. **Waste.** The catalog contract is a STORAGE shape, sized for the engine,
 *    MCP evidence, and incremental rebuilds. The browser reads a much smaller
 *    shape (`CatalogLike` / `OccLike` in `client/code-paths-types.ts`). It never
 *    touches `semanticFacts` (204 MB here), `reExports`, three of the four
 *    `features` maps, or five per-occurrence fields. Projecting to exactly the
 *    client's contract is lossless for the report and took 305 MB → 47 MB.
 *
 * 2. **Unboundedness.** 47 MB is still not a document you send anyone, and it
 *    grows with the repository. So the projection is then bounded by a byte
 *    budget, dropping the least important functions first — ranked by blast
 *    radius, the same signal the graph rules use for "what matters here".
 *
 * Truncation is a VISIBLE state, never a silent one: `omittedFunctions` rides
 * into the page and the Code Paths panel says so. A report that quietly showed
 * 5,000 of 28,327 functions would be exactly the "empty result that looks like
 * a clean result" this product exists to prevent.
 *
 * Mirrors `change-impact/bound-runs.ts`, which bounds the Change Impact models
 * the same way (ADR-0156).
 */

import { scriptContextJsonBytes } from '../script-context-json.js';

import type {
  GraphCatalog,
  GraphFunctionFeatures,
  GraphFunctionOccurrence,
} from '@opensip-cli/contracts';

/**
 * Byte budget for the inlined catalog. 8 MiB keeps a large repository's report
 * openable in a browser and small enough to attach to a PR, while leaving the
 * overwhelming majority of real projects untruncated (a ~5k-function project
 * projects to well under this).
 */
export const MAX_GRAPH_CATALOG_BYTES = 8_388_608;

/**
 * The per-occurrence fields the browser bundle reads (`OccLike`). Everything
 * else in a stored occurrence — `bodySize`, `bodySignature`, `enclosingClass`,
 * `decorators`, `definedInGenerated` — exists for the engine and MCP, and is
 * pure weight in the report.
 */
const OCCURRENCE_FIELDS = [
  'bodyHash',
  'simpleName',
  'qualifiedName',
  'filePath',
  'package',
  'line',
  'endLine',
  'column',
  'kind',
  'visibility',
  'inTestFile',
  'returnType',
  'params',
  'calls',
] as const;

/**
 * The catalog shape the report inlines — the client's contract, nothing more.
 *
 * The scalars are all read: `cacheKey` carries the engine mode the provenance
 * bar parses out of it, `language` drives the view-model projection, and
 * `version` identifies the contract to anyone reading the blob. They cost
 * bytes in the tens, unlike the payloads this projection exists to drop.
 */
export interface ReportGraphCatalog {
  readonly version?: string;
  readonly language?: string;
  readonly cacheKey?: string;
  readonly builtAt?: string;
  readonly resolutionMode?: string;
  /** Only `edge` is read (by the coupling view); the other feature maps are not. */
  readonly features: { readonly edge: unknown };
  readonly functions: Record<string, readonly Record<string, unknown>[]>;
}

export interface BoundedGraphCatalog {
  readonly catalog: ReportGraphCatalog | null;
  /** Functions in the source catalog, before bounding. */
  readonly totalFunctions: number;
  /** Functions dropped to fit the byte budget. `0` ⇒ the report is complete. */
  readonly omittedFunctions: number;
}

const EMPTY: BoundedGraphCatalog = { catalog: null, totalFunctions: 0, omittedFunctions: 0 };

type Occurrence = Record<string, unknown>;
type FunctionMap = Record<string, readonly Occurrence[]>;

/**
 * Keep only the fields the client reads. The input is the TYPED contract
 * occurrence and OCCURRENCE_FIELDS is checked against its keys at compile
 * time (plan 09 Task 8.5): a `contracts` field rename now breaks this build
 * instead of silently projecting `undefined` into the report.
 */
function projectOccurrence(occurrence: GraphFunctionOccurrence): Occurrence {
  const projected: Occurrence = {};
  for (const field of OCCURRENCE_FIELDS) {
    const value: unknown = occurrence[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

/**
 * Importance of one function, highest first. Blast radius is the engine's own
 * answer to "what matters here" (it drives `high-blast-untested`), so a
 * truncated report keeps the functions a reviewer is most likely to look for.
 * Ties break on body size, then on the key itself — the ordering must be
 * deterministic, or two runs over the same catalog would truncate differently.
 */
function compareByImportance(
  a: readonly [string, readonly GraphFunctionOccurrence[]],
  b: readonly [string, readonly GraphFunctionOccurrence[]],
  metrics: Readonly<Record<string, GraphFunctionFeatures>> | undefined,
): number {
  const [keyA] = a;
  const [keyB] = b;
  const blastA = metrics?.[keyA]?.blast?.score ?? 0;
  const blastB = metrics?.[keyB]?.blast?.score ?? 0;
  if (blastA !== blastB) return blastB - blastA;
  const linesA = metrics?.[keyA]?.bodyLines ?? 0;
  const linesB = metrics?.[keyB]?.bodyLines ?? 0;
  if (linesA !== linesB) return linesB - linesA;
  if (keyA < keyB) return -1;
  return keyA > keyB ? 1 : 0;
}

/**
 * Project the catalog to the client's contract, then drop the least important
 * functions until the result fits `maxBytes`.
 *
 * Each function's serialized cost is measured once and the budget is filled in
 * importance order — a re-serialize-per-drop loop would be quadratic on a
 * catalog with tens of thousands of functions, which is precisely the case that
 * matters.
 */
export function boundGraphCatalog(
  catalog: GraphCatalog | null | undefined,
  maxBytes: number = MAX_GRAPH_CATALOG_BYTES,
): BoundedGraphCatalog {
  if (catalog === null || catalog === undefined) return EMPTY;

  // Typed reads off the GraphCatalog contract (plan 09 Task 8.5) — the old
  // `as unknown as` local shape kept compiling across a contracts rename of
  // `features.blast.score`, silently ranking every function blast=0 and
  // dropping ARBITRARY (not least-important) functions in the truncation.
  const entries = Object.entries(catalog.functions);
  const totalFunctions = entries.length;

  const base = {
    version: catalog.version,
    language: catalog.language,
    ...(catalog.cacheKey === undefined ? {} : { cacheKey: catalog.cacheKey }),
    builtAt: catalog.builtAt,
    ...(catalog.resolutionMode === undefined ? {} : { resolutionMode: catalog.resolutionMode }),
    features: { edge: catalog.features?.edge ?? [] },
  };

  // Budget left for the function map once the fixed parts are accounted for.
  let budget = maxBytes - scriptContextJsonBytes({ ...base, functions: {} });

  const metrics = catalog.features?.function;
  const ranked = [...entries].sort((a, b) => compareByImportance(a, b, metrics));

  const kept: FunctionMap = {};
  let omittedFunctions = 0;
  for (const [key, occurrences] of ranked) {
    const projected = occurrences.map((occurrence) => projectOccurrence(occurrence));
    // `+ key.length + 8` approximates the map-entry overhead (quotes, colon,
    // comma) so the budget is not silently overrun by tens of thousands of keys.
    const cost = scriptContextJsonBytes(projected) + key.length + 8;
    if (cost > budget) {
      omittedFunctions++;
      continue;
    }
    budget -= cost;
    kept[key] = projected;
  }

  return {
    catalog: { ...base, functions: kept },
    totalFunctions,
    omittedFunctions,
  };
}
