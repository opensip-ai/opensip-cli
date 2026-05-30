/**
 * `opensip-tools.config.yml` parsing + validation for the `fit` command.
 *
 * Wraps `loadSignalersConfig` and `loadTargetsConfig` so that
 * `executeFit` gets a single resolve-or-error step. A missing/invalid
 * config is a HARD error — otherwise file-based checks silently produce
 * zero findings, the exact failure mode the CLI exists to prevent.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { loadSignalersConfig } from '../../signalers/index.js';
import { loadTargetsConfig } from '../../targets/index.js';

import type { SignalersConfig } from '../../signalers/types.js';
import type { ErrorResult, FitOptions } from '@opensip-tools/contracts';

export interface LoadedFitConfig {
  signalersConfig: SignalersConfig;
  targetsConfig: ReturnType<typeof loadTargetsConfig>['config'];
  targetRegistry: ReturnType<typeof loadTargetsConfig>['registry'];
}

/**
 * Resolve `signalersConfig` + `targetsConfig` from the project's
 * opensip-tools.config.yml. Returns an `ErrorResult` instead of throwing
 * so the caller maps it directly to the public failure shape — a
 * missing/invalid config is a HARD error (otherwise file-based checks
 * silently produce zero findings).
 */
export function loadFitConfig(
  args: FitOptions,
): LoadedFitConfig | { error: ErrorResult } {
  try {
    const signalersConfig = loadSignalersConfig(args.cwd, args.config);
    const targetsResult = loadTargetsConfig(args.cwd, args.config);
    return {
      signalersConfig,
      targetsConfig: targetsResult.config,
      targetRegistry: targetsResult.registry,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ evt: 'cli.config.load_failed', module: 'cli:fit', message });
    return {
      error: {
        type: 'error',
        message,
        suggestion: "Run 'opensip-tools init' to scaffold a config, or pass --config <path> to point at an existing one.",
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
}

/**
 * Warn loudly when the targets config declares languages with no
 * registered adapter. Silent acceptance would let users ship configs
 * that scan files but skip the language-aware string/comment filtering.
 *
 * Returns warning strings (one per unknown-language batch) rather than
 * writing to stderr — stderr writes during the Ink live view desync the
 * renderer's frame tracking. `executeFit` collects these and threads
 * them into `FitDoneResult.warnings`.
 *
 * Async only because `currentScope` is imported via dynamic import to
 * keep the executeFit body free of fitness↔core import arrows beyond
 * the kernel barrel. The scope is bound by the CLI pre-action-hook.
 *
 * @throws {Error} When called outside `runWithScope(...)` (no current scope).
 */
export async function validateLanguagesAgainstAdapters(
  targetRegistry: LoadedFitConfig['targetRegistry'],
): Promise<readonly string[]> {
  const { currentScope } = await import('@opensip-tools/core');
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'validateLanguagesAgainstAdapters() called outside runWithScope. ' +
        'fit pipeline must run inside a RunScope so language adapters resolve via cli.scope.languages.',
    );
  }
  const langRegistry = scope.languages;
  const knownLanguages = new Set<string>(langRegistry.list().flatMap((a) => [a.id, ...(a.aliases ?? [])]));
  const unknownLanguages = new Set<string>();
  for (const target of targetRegistry.getAll()) {
    const langs = target.config.languages ?? [];
    for (const lang of langs) {
      if (!knownLanguages.has(lang)) unknownLanguages.add(lang);
    }
  }
  if (unknownLanguages.size === 0) return [];

  const list = [...unknownLanguages].sort().join(', ');
  logger.warn({
    evt: 'cli.config.unknown_languages',
    module: 'cli:fit',
    unknown: [...unknownLanguages],
    known: [...knownLanguages],
  });
  return [
    `target config declares unknown language(s): ${list}. ` +
    `Known languages: ${[...knownLanguages].sort().join(', ')}. ` +
    `Files in unknown languages will scan with no string/comment filtering.`,
  ];
}
