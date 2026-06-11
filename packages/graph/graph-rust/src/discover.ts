/**
 * Rust file discovery — Stage 0 for the Rust adapter.
 *
 * Strategy:
 *   1. Locate `Cargo.toml`. We do NOT parse it to honor
 *      `[workspace] members = [...]` or `[lib]` / `[[bin]]` paths —
 *      that's a deliberate punt. Instead we recurse all `.rs` files from
 *      the project root excluding `target/`, which covers single crates
 *      and most workspace layouts. Workspace-aware discovery is a
 *      follow-up.
 *   2. If no `Cargo.toml` is present, the configPath is undefined and
 *      `cacheKey` falls back to the literal `no-config`.
 *   3. Records `Cargo.lock` (if present) as a sibling fingerprint —
 *      `cacheKey` prefers Cargo.lock since it's the resolved-dep hash;
 *      falls back to Cargo.toml.
 *
 * The collect-loop / realpath-dedup / config-precedence scaffolding lives
 * in `@opensip-tools/graph-adapter-common`; this module supplies only the
 * Rust-specific inputs.
 */

import { createDiscover } from '@opensip-tools/graph-adapter-common';

const EXCLUDED_DIR_GLOBS: readonly string[] = ['**/target/**', '**/node_modules/**', '**/.git/**'];

// Prefer Cargo.lock (resolved deps) over Cargo.toml (intent), since
// changing a dep version invalidates the call-graph more reliably than
// editing the manifest.
const CONFIG_CANDIDATES: readonly string[] = ['Cargo.lock', 'Cargo.toml'];

export const discoverFiles = createDiscover({
  extension: 'rs',
  excludedDirGlobs: EXCLUDED_DIR_GLOBS,
  configCandidates: CONFIG_CANDIDATES,
  languageId: 'rust',
});
