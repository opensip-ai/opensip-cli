/**
 * @fileoverview Confine the raw Drizzle handle (`DataStore.db`) to the
 * persistence ownership boundary.
 *
 * ADR-0009 ("public-API surface policy") + the `tables-only-in-persistence`
 * rule in `.config/dependency-cruiser.cjs`: `DataStore.db` (a raw Drizzle handle,
 * `packages/datastore/src/data-store.ts`) is intentionally PUBLIC. The
 * architecture gate confines *table symbols* to their owning persistence
 * layer, so a stray module cannot pair the public `db` handle with a foreign
 * table to bypass that table's repository. But dependency-cruiser
 * structurally CANNOT restrict raw `.db` *property access* itself: the
 * `options.includeOnly: '^packages/'` config drops every node_modules edge
 * before rules run, so a rule targeting the `drizzle-orm` query builder is
 * inert (the same reason `not-to-dev-dep` cannot fire). The residual gap —
 * a future module reaching `<datastore>.db.select(...)` / `.run(sql`...`)` to
 * query tables directly instead of going through an owner repository — has no
 * IMPORT edge to catch. This check closes that gap with a call-shape rule.
 *
 * DETECTION — regex on `strip-strings-and-comments`-filtered content (NOT AST).
 * Both string literals AND comment bodies are blanked before `analyze` runs, so
 * a `.db.select(` appearing in a doc-comment example (such as the ones in this
 * very file) never false-fires; only real call expressions survive. The shape
 * being matched is purely local and lexical: a `.db` property access whose
 * member is *immediately* a Drizzle query/builder method
 * (`.db.select(` / `.db.insert(` / `.db.delete(` / `.db.run(` …). The detector
 * also tracks obvious same-file aliases (`const db = store.db`,
 * `const { db } = store`) so a caller cannot bypass the check by peeling the
 * handle off first. Regexes are precise enough here because the protected
 * shapes are small local token sequences; requiring the trailing query method
 * (rather than bare `.db`) keeps false-positives near zero — an unrelated
 * `.db` field on some other object (e.g. `config.db`, `connection.db.host`)
 * does not trip unless it is used as a Drizzle query handle. `strip-strings-
 * and-comments` blanks both string literals and comment bodies so `.db.select(`
 * inside a literal or doc example never false-fires.
 *
 * ALLOWED BOUNDARY (no violation) — implemented inside `analyze` by inspecting
 * `filePath`, so the check is self-contained and correct regardless of the
 * project `targets` config:
 *   - `**\/src/persistence/**`           — each tool's owner repository layer
 *   - `packages/session-store/src/**`    — the session repository package
 *   - `packages/datastore/src/**`        — the layer that DEFINES `.db`
 * Test files (`*.test.ts`, `__tests__/`) are skipped — tests legitimately
 * reach into the handle to set up fixtures.
 *
 * SEVERITY — `error` / tags `['architecture']`: this is a data-ownership
 * boundary, aligned with the sibling architecture gate it complements.
 *
 * LEGITIMATE out-of-boundary raw `.db` use (should be vanishingly rare) is
 * exempted per-file via `@fitness-ignore-file restrict-raw-db-access` with a
 * justification comment.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Resolved-path fragments that identify a persistence-owned source file.
 * Raw `.db` access inside any of these is the intended ownership boundary and
 * is NOT flagged.
 */
const PERSISTENCE_BOUNDARY: readonly RegExp[] = [
  /\/src\/persistence\//,
  /packages\/session-store\/src\//,
  /packages\/datastore\/src\//,
];

/** Test-file fragments — skipped (fixtures legitimately reach the handle). */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/**
 * Drizzle query/builder methods. A `.db` access is only flagged when its
 * member is *immediately* one of these — i.e. the `.db` is being used as a
 * live query handle, not merely as a `.db` field on some unrelated object.
 */
const DRIZZLE_METHODS = [
  'select',
  'insert',
  'update',
  'delete',
  'transaction',
  'run',
  'get',
  'all',
  'values',
  'with',
] as const;

/**
 * Matches a property-access whose member is `db` followed immediately by a
 * Drizzle query method call: `<anything>.db.select(` / `.db.run(` / …
 */
const RAW_DB_QUERY = new RegExp(String.raw`\.db\.(?:${DRIZZLE_METHODS.join('|')})\s*\(`);

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/** Matches `const { db } = store` and `const { db: rawDb } = store`. */
const RAW_DB_DESTRUCTURE = new RegExp(
  String.raw`\b(?:const|let|var)\s+\{[^}]*\bdb\b\s*(?::\s*(${IDENTIFIER}))?[^}]*\}\s*=`,
  'g',
);

/** Matches `const rawDb = store.db`. */
const RAW_DB_ASSIGNMENT = new RegExp(
  String.raw`\b(?:const|let|var)\s+(${IDENTIFIER})\s*=\s*[^;\n]+\.db\b`,
  'g',
);

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function collectRawDbAliases(line: string): string[] {
  const aliases: string[] = [];
  for (const match of line.matchAll(RAW_DB_DESTRUCTURE)) {
    aliases.push(match[1] ?? 'db');
  }
  for (const match of line.matchAll(RAW_DB_ASSIGNMENT)) {
    if (match[1]) aliases.push(match[1]);
  }
  return aliases;
}

function rawDbAliasQuery(alias: string): RegExp {
  return new RegExp(String.raw`\b${escapeRegExp(alias)}\.(?:${DRIZZLE_METHODS.join('|')})\s*\(`);
}

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic without standing up the full Check framework. Operates on
 * `strip-strings-and-comments`-filtered content so `.db.select(` appearing
 * inside a string literal or comment/doc example does not false-fire — only real call sites
 * are flagged. `filePath` gates the persistence-boundary exemption.
 */
export function analyzeRawDbAccess(content: string, filePath: string): CheckViolation[] {
  // Persistence-owned code and test fixtures legitimately reach the handle.
  if (TEST_PATH.test(filePath)) return [];
  if (PERSISTENCE_BOUNDARY.some((re) => re.test(filePath))) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  const rawDbAliases = new Set<string>();
  for (const [i, line] of lines.entries()) {
    for (const alias of collectRawDbAliases(line)) {
      rawDbAliases.add(alias);
    }
    // @fitness-ignore-next-line null-safety -- rawDbAliasQuery returns a RegExp (never null/undefined), so .test is always safe; the heuristic can't see the return type through the call.
    const usesRawDbAlias = [...rawDbAliases].some((alias) => rawDbAliasQuery(alias).test(line));
    if (RAW_DB_QUERY.test(line) || usesRawDbAlias) {
      violations.push({
        message:
          'Raw Drizzle handle (`DataStore.db`) used outside the persistence ' +
          'boundary. Querying tables directly through `.db` bypasses the owning ' +
          "module's repository and the data-ownership seam (ADR-0009, " +
          '`tables-only-in-persistence`).',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Route the query through the owning repository in that module’s ' +
          '`src/persistence/` layer (or `session-store`). If this access is ' +
          'genuinely persistence-owned, move the file into the boundary; if it ' +
          'is a deliberate exception, add `@fitness-ignore-file ' +
          'restrict-raw-db-access` with a justification comment.',
      });
    }
  }
  return violations;
}

export const restrictRawDbAccess = defineCheck({
  id: 'b3d7f5c1-9a64-4e2b-8c11-7f0a2d6e4b90',
  slug: 'restrict-raw-db-access',
  description:
    'Confine the raw Drizzle handle (DataStore.db) to the persistence ownership boundary (ADR-0009)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  // strip-strings-and-comments so `.db.select(` etc. appearing inside string
  // literals OR comment/JSDoc examples (including this very file's header) do
  // not false-fire; only real call expressions survive.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => analyzeRawDbAccess(content, filePath),
});
