/**
 * cli-defaults — read the `cli:` block from
 * `opensip-tools.config.yml` and merge it into Commander-parsed opts.
 *
 * Extracted from `index.ts` so the merge precedence is testable and the
 * bootstrap module owns config-resolution end-to-end. Order is
 * load → merge → derive (silent/debug) so flag-driven log mode reflects
 * the merged opts (F10).
 *
 * The schema + loader live in `@opensip-tools/config`
 * (`loadCliDefaults`, `cliConfigSchema`) — the `cli:` block is
 * tool-agnostic and a project shipping only `simulation` shouldn't need
 * fitness installed just to read its own CLI defaults. Relocated out of
 * `@opensip-tools/contracts` in 2.10.1 (ADR-0023; restores contracts
 * types-only). Audit 2026-05-23 G2.
 */

import { loadCliDefaults as loadCliDefaultsFromConfig, resolveApiKey } from '@opensip-tools/config';
import { logger } from '@opensip-tools/core';

import type { CliDefaults } from '@opensip-tools/config';

// Re-export the type at the same name the rest of the bootstrap path
// already imports — internal bootstrap call sites stay stable.
export type { CliDefaults } from '@opensip-tools/config';

/**
 * Best-effort load of the `cli:` block. Falls back to `{}` when the
 * config is missing or malformed — config-presence is optional. The
 * underlying loader (in `@opensip-tools/contracts`) is already
 * permissive on every failure path; the wrapper here exists so the
 * absence path emits a structured debug log keyed against `cli:` (the
 * contracts loader stays dependency-light and doesn't reach for the
 * logger).
 */
export function loadCliDefaults(cwd: string, explicitConfigPath?: string): CliDefaults {
  try {
    return loadCliDefaultsFromConfig(cwd, explicitConfigPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug({
      evt: 'cli.config.unavailable',
      module: 'cli',
      cwd,
      error: message,
    });
    return {};
  }
}

/**
 * Apply the `cli:` defaults onto Commander-parsed opts when the
 * corresponding flag wasn't supplied. Mutates `opts` in place — matches
 * Commander's expectation that opts are the post-merge truth.
 */
export function mergeConfigDefaults(opts: Record<string, unknown>, config: CliDefaults): void {
  // NOTE (ADR-0022): `recipe` is deliberately NOT merged here. Recipe defaults
  // are tool-scoped — `fit`/`graph`/`sim` own disjoint recipe namespaces, so a
  // single tool-agnostic default leaked a fit recipe into graph/sim and aborted
  // them (`Unknown graph recipe '<fit-recipe>'`). Each tool now resolves its own
  // default via `resolveToolRecipeName` (its `<tool>.recipe` block + the
  // deprecated `cli.recipe` fallback). After this change `opts.recipe` reflects
  // only the explicit `--recipe` flag.
  if (config.verbose && opts.verbose === false) opts.verbose = config.verbose;
  if (config.json && opts.json === false) opts.json = config.json;
  if (config.reportTo && opts.reportTo === undefined) opts.reportTo = config.reportTo;
  if (config.exclude && Array.isArray(opts.exclude) && (opts.exclude as string[]).length === 0) {
    (opts.exclude as string[]).push(...config.exclude);
  }
  if (opts.apiKey === undefined) {
    opts.apiKey = config.apiKey ?? resolveApiKey();
  }
}
