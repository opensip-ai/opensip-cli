/**
 * Cache normalize (DRY-2 exception, justified at compile time).
 *
 * Both cache/read and cache/write must agree on the catalog's
 * normalized serialization form. A single shared function is the only
 * way to compile-time-enforce that "what we wrote is what we read."
 */

import type { Catalog, FunctionOccurrence } from '../types.js';

/** Sort top-level keys + occurrence arrays so JSON output is byte-stable. */
export function normalizeCatalogForSerialization(catalog: Catalog): Catalog {
  const sortedKeys = Object.keys(catalog.functions).sort();
  const functions: Record<string, readonly FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    readonly FunctionOccurrence[]
  >;
  for (const key of sortedKeys) {
    if (!Object.hasOwn(catalog.functions, key)) continue;
    const occurrences: readonly FunctionOccurrence[] | undefined = catalog.functions[key];
    if (!occurrences) continue;
    // Within a name, sort by filePath + line for stability.
    const sortedOccurrences = [...occurrences].sort((a, b) => {
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });
    functions[key] = sortedOccurrences;
  }
  // Spread catalog last so filesFingerprint and any future fields are
  // preserved through the round-trip.
  return { ...catalog, functions };
}
