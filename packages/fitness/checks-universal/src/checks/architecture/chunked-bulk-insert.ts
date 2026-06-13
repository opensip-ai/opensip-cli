/**
 * @fileoverview A Drizzle bulk insert of an unbounded (mapped) array must be
 * CHUNKED — a single multi-row `INSERT` is capped by SQLite's bound-parameter
 * ceiling.
 *
 * WHY (the drift this freezes out):
 *   Drizzle builds ONE multi-row `INSERT` with N bound parameters PER ROW from
 *   `.values(rows)`. The bundled SQLite caps bound parameters at
 *   `SQLITE_MAX_VARIABLE_NUMBER` (32766), so an insert of a row set derived from
 *   an unbounded collection (e.g. `rows = entries.map(...)`) throws
 *   `too many SQL variables` once `rows.length * colsPerRow > 32766`. This is
 *   exactly the large-backlog scenario the baseline ratchet targets, so the
 *   failure surfaces precisely where the feature is supposed to work.
 *
 * DETECTION — regex on `strip-strings-and-comments`-filtered content (NOT AST):
 *   (1) collect array variables assigned from a `.map(` (a mapped row set whose
 *       size tracks an upstream collection — i.e. unbounded), then
 *   (2) flag a `.values(<that-var>)` call, or an inline `.values(<x>.map(...))`.
 *   The COMPLIANT chunked shape — `for (const chunk of chunks) { ...
 *   .values(chunk) }` — does NOT match, because `chunk` is a loop binding, not a
 *   `.map(`-assigned variable. So a correctly chunked repo passes clean.
 *
 * SCOPE — the persistence layers that own Drizzle inserts (datastore,
 * session-store, each tool's `src/persistence/`). Adopter repos are unaffected.
 * Test files are skipped.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Persistence layers that own raw Drizzle inserts. */
const PERSISTENCE_LAYER: readonly RegExp[] = [
  /packages\/datastore\/src\//,
  /packages\/session-store\/src\//,
  /\/src\/persistence\//,
];

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/** `const rows = <...>.map(` — a mapped (size-tracks-collection, unbounded) array. */
const MAPPED_ARRAY_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+(${IDENTIFIER})\s*=\s*[^;\n]*\.map\s*\(`,
  'g',
);

/** `.values(<x>.map(...))` — an unbounded mapped array passed inline to a bulk insert. */
const INLINE_MAPPED_VALUES_RE = /\.values\s*\(\s*[^);\n]*\.map\s*\(/;

function valuesOfVarRe(varName: string): RegExp {
  return new RegExp(String.raw`\.values\s*\(\s*${varName}\s*\)`);
}

/**
 * Pure analysis over one persistence-layer source file. Flags a bulk insert of
 * an unbounded mapped array that is not chunked. Exported for unit tests.
 */
export function analyzeChunkedBulkInsert(content: string, filePath: string): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_PATH.test(normalized)) return [];
  if (!PERSISTENCE_LAYER.some((re) => re.test(normalized))) return [];

  // Pass 1: collect mapped-array variable names across the whole file (a var may
  // be declared above the insert).
  const mappedVars = new Set<string>();
  MAPPED_ARRAY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MAPPED_ARRAY_RE.exec(content)) !== null) {
    if (m[1]) mappedVars.add(m[1]);
  }

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    const inlineMapped = INLINE_MAPPED_VALUES_RE.test(line);
    const mappedVarValues = [...mappedVars].some((v) => valuesOfVarRe(v).test(line));
    if (!inlineMapped && !mappedVarValues) continue;
    violations.push({
      line: i + 1,
      message:
        'Bulk insert of an unbounded (mapped) array via `.values(...)` is not ' +
        'chunked. Drizzle emits ONE multi-row INSERT; SQLite caps bound parameters ' +
        'at 32766, so this throws `too many SQL variables` once the row set is large ' +
        '— exactly the large-backlog case the baseline ratchet targets.',
      severity: 'error',
      suggestion:
        'Chunk the rows before inserting: iterate `for (const chunk of chunkRows(rows, N))` ' +
        '(N chosen so N * columnsPerRow stays well under 32766) and call ' +
        '`.values(chunk)` per chunk inside the transaction. If the array is provably ' +
        'small/bounded, exempt with `@fitness-ignore-file chunked-bulk-insert` and a reason.',
      type: 'chunked-bulk-insert',
    });
  }
  return violations;
}

export const chunkedBulkInsert = defineCheck({
  id: 'a780abb3-99f0-4e5a-9b05-a5bcb2fddc3b',
  slug: 'chunked-bulk-insert',
  description:
    'A Drizzle bulk insert of an unbounded mapped array must be chunked (SQLite caps bound parameters at 32766) — single .values(rows) crashes on large row sets',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => analyzeChunkedBulkInsert(content, filePath),
});
