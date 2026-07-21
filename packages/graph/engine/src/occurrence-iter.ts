/**
 * Twin-aware occurrence iteration helpers (ADR-0178).
 *
 * `Indexes.byBodyHash` is last-writer-wins content dedup. Occurrence-local rules
 * and twin-sensitive `inTestFile` predicates must walk
 * `occurrencesByHash` (or these helpers) so a test twin that wins the hash slot
 * cannot mask a production twin.
 */

import type { FunctionOccurrence, Indexes } from './types.js';

/** Yield every occurrence in the catalog (all body-hash twins). */
export function* eachOccurrence(indexes: Indexes): IterableIterator<FunctionOccurrence> {
  for (const occs of indexes.occurrencesByHash.values()) {
    yield* occs;
  }
}

/**
 * True when **any** twin of `bodyHash` lives in a test file.
 * Used as a seed predicate (e.g. test-reachability BFS).
 */
export function anyTwinInTestFile(indexes: Indexes, bodyHash: string): boolean {
  const occs = indexes.occurrencesByHash.get(bodyHash);
  if (occs !== undefined && occs.length > 0) {
    return occs.some((o) => o.inTestFile);
  }
  return indexes.byBodyHash.get(bodyHash)?.inTestFile === true;
}

/**
 * True when **every** resolvable twin of `bodyHash` lives in a test file
 * (no production twin). Used when asking whether a caller hash is purely test.
 */
export function everyTwinInTestFile(indexes: Indexes, bodyHash: string): boolean {
  const occs = indexes.occurrencesByHash.get(bodyHash);
  if (occs !== undefined && occs.length > 0) {
    return occs.every((o) => o.inTestFile);
  }
  return indexes.byBodyHash.get(bodyHash)?.inTestFile === true;
}

/**
 * True when at least one twin is production (not test, not generated).
 * Used for production entry-point seeding over a body hash.
 */
export function hasProductionTwin(indexes: Indexes, bodyHash: string): boolean {
  const occs = indexes.occurrencesByHash.get(bodyHash);
  if (occs !== undefined && occs.length > 0) {
    return occs.some((o) => !o.inTestFile && !o.definedInGenerated);
  }
  const winner = indexes.byBodyHash.get(bodyHash);
  return winner !== undefined && !winner.inTestFile && !winner.definedInGenerated;
}
