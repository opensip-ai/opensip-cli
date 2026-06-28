/**
 * artifact-retention — host-owned pruning of the per-tool artifact store.
 *
 * The host writes every scanner/baseline/catalog artifact through the
 * `writeArtifact` seam into `<project>/.runtime/artifacts/<tool>/<runId>/<name>`
 * (the substrate composes the `<runId>` segment; ADR-0090 Phase-0 decision 1).
 * Unbounded, that store would grow one run-dir per invocation forever. This
 * helper keeps the N most-recent run-dirs per tool and removes the rest.
 *
 * A separate, pure-IO testable unit (mirroring `atomic-artifact-write.ts` vs
 * `artifact-seams.ts`): the write seam calls it after a successful artifact
 * write, gated on the target living inside the artifact store. Every failure
 * path is defensive — a prune problem must NEVER fail the run, so nothing here
 * throws (the seam additionally wraps the call).
 */

import { readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Default number of per-tool run-dirs retained when `cli.artifacts.keep` is not
 * set in `opensip-cli.config.yml`. MUST match the Zod default declared on
 * `cliConfigSchema.artifacts.keep` (in `@opensip-cli/config`); kept here as a
 * literal because the config layer cannot import from the cli layer.
 */
export const DEFAULT_ARTIFACT_RETENTION_KEEP = 10;

interface RunDir {
  readonly name: string;
  readonly full: string;
  readonly mtimeMs: number;
}

/**
 * Order run-dirs newest-first by mtime, with a deterministic name tie-break
 * (descending) so equal-mtime dirs prune in a stable order.
 */
function byMostRecent(a: RunDir, b: RunDir): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.name === b.name) return 0;
  return a.name < b.name ? 1 : -1;
}

/**
 * List the immediate child directories of `<artifactsDir>/<tool>` as candidate
 * per-run dirs, each stamped with its mtime. A missing dir (or a path that is a
 * file, not a dir) yields `[]` — nothing to prune. Non-directory entries (a tool
 * writing a file directly under `<tool>/`) are ignored.
 */
function listRunDirs(toolDir: string): RunDir[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(toolDir, { withFileTypes: true });
  } catch {
    // @swallow-ok missing/!dir tool subdir → nothing to prune
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = join(toolDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        // @swallow-ok unreadable run dir sorts oldest (mtime 0) so it is pruned first
        mtimeMs = 0;
      }
      return { name: entry.name, full, mtimeMs };
    });
}

/**
 * Prune `<artifactsDir>/<tool>` down to the `keep` most-recent run-dirs.
 *
 * Run-dirs are ordered newest-first by mtime (tie-broken by name, descending,
 * for determinism); everything past the first `keep` is removed
 * (`rmSync({ recursive: true, force: true })`). Defensive throughout:
 *   - missing tool dir → no-op;
 *   - `keep <= 0` (or non-finite) → treated as disabled, no-op;
 *   - a failed removal is swallowed (best-effort) and never propagated.
 */
export function pruneArtifactRetention(tool: string, artifactsDir: string, keep: number): void {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const toolDir = join(artifactsDir, tool);
  const runDirs = listRunDirs(toolDir).sort(byMostRecent);
  for (const stale of runDirs.slice(keep)) {
    try {
      rmSync(stale.full, { recursive: true, force: true });
    } catch {
      // @swallow-ok best-effort prune; a removal failure must not fail the run
    }
  }
}
