/**
 * `opensip-cli.config.yml` parsing + validation for the `fit` command.
 *
 * Wraps `loadSignalersConfig` and `loadTargetsConfig` so that
 * `executeFit` gets a single resolve-or-error step. A missing/invalid
 * config is a HARD error — otherwise file-based checks silently produce
 * zero findings, the exact failure mode the CLI exists to prevent.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { createToolLogger } from '@opensip-cli/core';

import { loadSignalersConfig } from '../../signalers/index.js';
import { loadTargetsConfig } from '../../targets/index.js';

import type { SignalersConfig } from '../../signalers/types.js';
import type { ErrorResult, FitOptions } from '@opensip-cli/contracts';

const log = createToolLogger('fitness:cli');

export interface LoadedFitConfig {
  signalersConfig: SignalersConfig;
  targetsConfig: ReturnType<typeof loadTargetsConfig>['config'];
  targetRegistry: ReturnType<typeof loadTargetsConfig>['registry'];
}

/**
 * Resolve `signalersConfig` + `targetsConfig` for this run. Scope-first
 * (ADR-0023 one-reader): on CLI paths both loaders project from the
 * host-validated `scope.configDocument`; the file read is the scope-less
 * fallback (programmatic use, unit tests). Returns an `ErrorResult` instead
 * of throwing so the caller maps it directly to the public failure shape — a
 * missing/invalid config is a HARD error (otherwise file-based checks
 * silently produce zero findings).
 */
export function loadFitConfig(args: FitOptions): LoadedFitConfig | { error: ErrorResult } {
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
    log.warn({ evt: 'cli.config.load_failed', module: 'cli:fit', message });
    return {
      error: {
        type: 'error',
        message,
        suggestion:
          "Run 'opensip init' to scaffold a config, or pass --config <path> to point at an existing one.",
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
}

/**
 * Warn loudly when the targets config declares a `languages:` tag that is
 * neither backed by a content-filter adapter NOR a recognized non-code
 * format — i.e. a likely typo. Silent acceptance would let users ship
 * configs whose files match no check and skip filtering with no signal.
 *
 * `languages:` is a *matching dimension* (it routes files to checks via
 * `findByScope`). A subset of those tags have a registered
 * {@link LanguageAdapter} that strips strings/comments; another set are
 * recognized non-code formats (JSON, YAML, Markdown, …) that are valid
 * matching tags but intentionally have no adapter — files in those scan
 * raw, which is correct, so they are NOT warned about. Only genuinely
 * unrecognized tags (e.g. `pythonn`) warn.
 *
 * Returns warning strings (one per unknown-language batch) rather than
 * writing to stderr — stderr writes during the Ink live view desync the
 * renderer's frame tracking. `executeFit` collects these and threads
 * them into the run warnings the live renderer surfaces.
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
  const { currentScope, isRecognizedNonCodeFormat } = await import('@opensip-cli/core');
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'validateLanguagesAgainstAdapters() called outside runWithScope. ' +
        'fit pipeline must run inside a RunScope so language adapters resolve via cli.scope.languages.',
    );
  }
  const langRegistry = scope.languages;
  const knownLanguages = new Set<string>(
    langRegistry.list().flatMap((a) => [a.id, ...(a.aliases ?? [])]),
  );
  const unknownLanguages = new Set<string>();
  for (const target of targetRegistry.getAll()) {
    const langs = target.config.languages ?? [];
    for (const lang of langs) {
      // A tag is legitimate if it either has a content-filter adapter or
      // is a recognized adapter-less format (JSON/YAML/Markdown/…). Only
      // truly unrecognized tags fall through to the warning.
      if (knownLanguages.has(lang) || isRecognizedNonCodeFormat(lang)) continue;
      unknownLanguages.add(lang);
    }
  }
  if (unknownLanguages.size === 0) return [];

  const list = [...unknownLanguages].sort().join(', ');
  log.warn({
    evt: 'cli.config.unknown_languages',
    module: 'cli:fit',
    unknown: [...unknownLanguages],
    known: [...knownLanguages],
  });
  return [
    `target config declares unrecognized language tag(s): ${list}. ` +
      `These match no content-filter adapter and are not a recognized non-code ` +
      `format — likely a typo. Known code languages: ${[...knownLanguages].sort().join(', ')}. ` +
      `Files under an unrecognized tag scan with no string/comment filtering.`,
  ];
}
