/**
 * cli-defaults — read the `cli:` block from
 * `opensip-tools.config.yml` and merge it into Commander-parsed opts.
 *
 * Extracted from `index.ts` so the merge precedence is testable and the
 * bootstrap module owns config-resolution end-to-end. Order is
 * load → merge → derive (silent/debug) so flag-driven log mode reflects
 * the merged opts (F10).
 */

import { logger } from '@opensip-tools/core';
import { loadSignalersConfig } from '@opensip-tools/fitness';

import { resolveApiKey } from '../commands/configure.js';

import type { SignalersConfig } from '@opensip-tools/fitness';

export type CliDefaults = SignalersConfig['cli'];

/**
 * Best-effort load of the `cli:` block. Falls back to `{}` when the
 * config is missing or malformed — config-presence is optional.
 */
export function loadCliDefaults(cwd: string, explicitConfigPath?: string): CliDefaults {
  try {
    return loadSignalersConfig(cwd, explicitConfigPath).cli;
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
  if (config.recipe && opts.recipe === undefined) opts.recipe = config.recipe;
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
