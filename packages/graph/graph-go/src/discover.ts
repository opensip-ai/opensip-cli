/**
 * Go file discovery.
 *
 * Strategy mirrors graph-rust:
 *   1. Locate `go.mod`. We do NOT parse it — recursive `.go` glob with
 *      vendor/ excluded handles single modules and most workspace
 *      layouts. Go workspace files (`go.work`) listing multiple
 *      modules would require parsing; that's a follow-up.
 *   2. If no go.mod present, configPath is undefined; cacheKey falls
 *      back to the literal `no-config`.
 *   3. Records go.sum (if present) as the fingerprint — prefers go.sum
 *      since it holds the resolved-dep hashes; falls back to go.mod.
 *
 * Excluded directories:
 *   - `vendor/` — Go's vendored-dep directory; semantically third-party.
 *   - `node_modules/` — rare in Go projects but defensive.
 *   - `.git/` — VCS metadata.
 *
 * The collect-loop / realpath-dedup / config-precedence scaffolding lives
 * in `@opensip-tools/graph-adapter-common`; this module supplies only the
 * Go-specific inputs (extension, excludes, config precedence, log tag).
 */

import { createDiscover } from '@opensip-tools/graph-adapter-common';

const EXCLUDED_DIR_GLOBS: readonly string[] = ['**/vendor/**', '**/node_modules/**', '**/.git/**'];

// Prefer go.sum (resolved deps with hashes) over go.mod (intent).
const CONFIG_CANDIDATES: readonly string[] = ['go.sum', 'go.mod'];

export const discoverFiles = createDiscover({
  extension: 'go',
  excludedDirGlobs: EXCLUDED_DIR_GLOBS,
  configCandidates: CONFIG_CANDIDATES,
  languageId: 'go',
});
