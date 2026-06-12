// @fitness-ignore-file error-handling-quality -- the two realpathSync probes (root normalization + per-unit discovery) intentionally fall through: the first uses the resolved path when realpath fails (e.g. a path inside a symlinked dir), the second skips a workspace unit the adapter can't discover (mirrors resolveShards in graph.ts). Both are documented at the call site.
// @fitness-ignore-file detached-promises -- handleGraphError is synchronous (void); the heuristic flags it as a discarded promise inside the async handler. Mirrors the same pragma on graph.ts for the identical CLI-error-boundary pattern.
/**
 * `opensip graph --list-files` — discovery-only mode.
 *
 * Resolves the exact source-file set the graph build would analyze for the
 * requested scope and prints it, WITHOUT building the catalog. This is the
 * cheap, side-effect-free way to answer "which files does graph actually
 * see?" — e.g. to diff graph's view of a repo against `git ls-files`.
 *
 * Faithfulness: it calls the same adapter stage-0 `discoverFiles` the real
 * pipeline uses (orchestrate.ts) for the same scope, so the list reflects a
 * real run — `.d.ts` excluded, TypeScript extension-priority collisions
 * collapsed (a `foo.tsx` shadowed by a sibling `foo.ts` is dropped), and each
 * tsconfig's include/exclude honored.
 *
 * Scope mirrors the `graph` command's own scoping:
 *   - bare            → whole project (the dominant-language adapter's
 *                       whole-tree discovery; this is the set a single-process
 *                       build analyzes)
 *   - `<path>...`     → union of each positional subtree's discovery
 *   - `--workspace`   → union of every detected workspace unit's discovery
 *                       (per-unit tsconfigs, mirrors resolveShards) — note
 *                       this can differ from the whole-project set when a
 *                       package's tsconfig excludes paths the root tree does
 *                       not (e.g. `__fixtures__`)
 *   - `--language X`  → forces adapter X for discovery
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, logger } from '@opensip-cli/core';

import { currentAdapterRegistry } from '../lang-adapter/registry.js';
import { GraphAdapterSelector } from '../lang-adapter/selector.js';

import { handleGraphError } from './graph.js';
import { resolvePositionalPaths } from './positional-paths.js';
import { resolveAdaptersForRun } from './resolve-adapters.js';
import { discoverPolyglotUnits } from './workspace-runner.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphLanguageAdapter } from '../lang-adapter/types.js';
import type { ToolCliContext } from '@opensip-cli/core';

const MODULE_GRAPH_CLI = 'graph:cli';

/**
 * Run `graph --list-files`: resolve the discovery set for the scope encoded in
 * `opts` and emit it through the CLI seam (`emitJson` for `--json`, the
 * `graph-status` render path otherwise — never raw stdout). Always sets an
 * exit code; never throws to the caller (errors are mapped via
 * `handleGraphError`, the same boundary `executeGraph` uses).
 */
export async function executeListFiles(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.list-files.start', module: MODULE_GRAPH_CLI, cwd: opts.cwd });
  try {
    // Same guard the full command applies (validateMutuallyExclusiveFlags):
    // a whole-workspace fan-out and an explicit subtree scope are contradictory.
    if (opts.workspace === true && (opts.paths?.length ?? 0) > 0) {
      throw new ConfigurationError(
        '--workspace and positional paths are mutually exclusive. Use one or the other.',
      );
    }

    const files =
      opts.workspace === true ? await discoverWorkspaceFiles(opts, cli) : discoverScopedFiles(opts);

    const rel = relativizeSorted(files, realpathOrResolve(opts.cwd));

    if (opts.json === true) {
      // Machine path: the general-purpose JSON seam (NOT a signal envelope).
      cli.emitJson({ count: rel.length, files: rel });
    } else {
      // Human/pipe path: pre-composed lines through the render seam. The
      // body is JUST the paths (one per line, forward-slashed to match
      // `git ls-files`) so the output pipes cleanly into `sort`/`comm`/`diff`.
      await cli.render({ type: 'graph-status', lines: rel });
    }

    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.list-files.complete',
      module: MODULE_GRAPH_CLI,
      fileCount: rel.length,
    });
  } catch (error) {
    handleGraphError('list-files', error, cli);
  }
}

/**
 * Whole-project / positional-subtree discovery. Uses the dominant-language
 * adapter (or `--language`) and unions the discovery of each scope — exactly
 * the adapter calls `runGraph` (bare) and `executeMultiPathGraph`
 * (positional) make at stage 0.
 */
function discoverScopedFiles(opts: GraphCommandOptions): readonly string[] {
  const adapter = resolveDiscoveryAdapter(opts);
  const scopes =
    opts.paths && opts.paths.length > 0 ? resolvePositionalPaths(opts.paths, opts.cwd) : [opts.cwd];
  const all: string[] = [];
  for (const scope of scopes) {
    const discovered = adapter.discoverFiles({ cwd: scope });
    all.push(...discovered.files);
  }
  return all;
}

/**
 * Workspace fan-out discovery: enumerate units via the detected adapters'
 * `discoverWorkspaceUnits`, then union each unit's stage-0 discovery. Mirrors
 * `resolveShards` in graph.ts (single discovery adapter; a unit the adapter
 * can't discover is skipped, not fatal), so the set equals what a real
 * `graph --workspace` run analyzes.
 */
async function discoverWorkspaceFiles(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<readonly string[]> {
  const adapters = resolveAdaptersForRun(opts, cli);
  const units = await discoverPolyglotUnits(opts.cwd, adapters);
  if (units.length === 0) {
    const adapterLabel = adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip graph --list-files' for whole-project analysis.`,
    );
  }
  const adapter = resolveDiscoveryAdapter(opts);
  const all: string[] = [];
  for (const unit of units) {
    try {
      const discovered = adapter.discoverFiles({
        cwd: unit.rootDir,
        configPathOverride: unit.configPath,
      });
      all.push(...discovered.files);
    } catch {
      continue; // a unit the graph adapter can't discover is skipped, not fatal
    }
  }
  return all;
}

/**
 * Pick the discovery adapter the same way the non-workspace build does
 * (`pickAdapterFor` in orchestrate.ts): `--language` names it explicitly,
 * otherwise the file-extension dominance heuristic chooses.
 */
function resolveDiscoveryAdapter(opts: GraphCommandOptions): GraphLanguageAdapter {
  return new GraphAdapterSelector(currentAdapterRegistry()).pick({
    cwd: opts.cwd,
    language: opts.language,
  });
}

/** Resolve `cwd` to an absolute, realpath'd root (matching the realpath'd
 *  discovery paths) so relativization lands clean. Falls back to the
 *  non-realpath'd absolute path if the probe fails. */
function realpathOrResolve(cwd: string): string {
  const abs = resolve(cwd);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Make the absolute discovery paths relative to `rootAbs`, dedupe, and sort.
 * Paths are forward-slash normalized so the output is byte-comparable with
 * `git ls-files` regardless of platform separator.
 */
function relativizeSorted(files: readonly string[], rootAbs: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const rel = f.startsWith(rootAbs + sep) ? f.slice(rootAbs.length + 1) : f;
    const key = rel.split(sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  out.sort();
  return out;
}
