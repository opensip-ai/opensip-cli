/**
 * @fileoverview chunked-bulk-insert — a Drizzle bulk insert of an unbounded
 *               (mapped) row set must be chunked. Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it
 * encodes opensip-cli' OWN persistence layout by first-party path
 * (`packages/datastore/src`, `packages/session-store/src`, each tool's
 * `src/persistence/`). A consumer with a different ORM or layout does not share
 * those facts, so the rule is opensip-internal until rewritten generically.
 *
 * WHY: Drizzle emits ONE multi-row INSERT from `.values(rows)`. The bundled
 * SQLite caps bound parameters at 32766, so an insert of a row set derived from
 * an unbounded collection (`rows = entries.map(...)`) throws
 * `too many SQL variables` once it is large — exactly the large-backlog case the
 * baseline ratchet targets. The COMPLIANT chunked shape
 * (`for (const chunk of chunkRows(rows, N)) { ... .values(chunk) }`) does not
 * match: `chunk` is a loop binding, not the `.map(`-assigned variable.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** First-party persistence layers that own raw Drizzle inserts. */
const PERSISTENCE_LAYER = [
  /packages\/datastore\/src\//,
  /packages\/session-store\/src\//,
  /\/src\/persistence\//,
];

/** Test-file fragments — skipped. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `const|let|var <id> =` declaration; the assigned identifier is captured. */
const DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

/** A `.map(` call — marks a row set whose size tracks an upstream collection. */
const MAP_CALL_RE = /\.map\s*\(/;

/** A `.values(` bulk-insert call. */
const VALUES_CALL_RE = /\.values\s*\(/;

/** `.values(<varName>)` — the bulk insert consumes exactly this variable. */
function valuesOfVarRe(varName) {
  return new RegExp(String.raw`\.values\s*\(\s*${varName}\s*\)`);
}

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeChunkedBulkInsert(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_PATH.test(normalized)) return [];
  if (!PERSISTENCE_LAYER.some((re) => re.test(normalized))) return [];

  const lines = content.split('\n');

  // Pass 1: collect mapped-array variable names (a declaration whose line also
  // contains a `.map(` call). A var may be declared above the insert that uses it.
  const mappedVars = new Set();
  for (const line of lines) {
    const decl = DECL_RE.exec(line);
    if (decl?.[1] && MAP_CALL_RE.test(line)) mappedVars.add(decl[1]);
  }

  // Pass 2: flag a `.values(...)` whose argument is a mapped-array variable or an
  // inline `.map(...)` (an unbounded row set) — but NOT a per-chunk loop binding.
  const violations = [];
  for (const [i, line] of lines.entries()) {
    const valuesCall = VALUES_CALL_RE.exec(line);
    if (!valuesCall) continue;
    const afterValues = line.slice(valuesCall.index + valuesCall[0].length);
    const inlineMapped = MAP_CALL_RE.test(afterValues);
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

export const checks = [
  defineCheck({
    id: 'a780abb3-99f0-4e5a-9b05-a5bcb2fddc3b',
    slug: 'chunked-bulk-insert',
    description:
      'A Drizzle bulk insert of an unbounded mapped array must be chunked (SQLite caps bound parameters at 32766) — single .values(rows) crashes on large row sets',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => analyzeChunkedBulkInsert(content, filePath),
  }),
];
