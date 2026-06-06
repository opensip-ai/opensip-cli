/**
 * Resolve which language adapters apply to a graph run.
 *
 * Extracted from `graph.ts` so both the full-run orchestrator
 * (`executeGraph`) and the discovery-only `--list-files` path
 * (`executeListFiles`) share one adapter-selection rule rather than
 * duplicating it — and so the new list-files module does not have to
 * import the large graph command handler just for this helper.
 */

import { ConfigurationError } from '@opensip-tools/core';

import { detectLanguages } from './detect.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { LanguageAdapter, ToolCliContext } from '@opensip-tools/core';

/**
 * Resolve which language adapters apply to this run. With `--language`
 * set, returns exactly that adapter (errors if unregistered). Without
 * it, runs marker-based detection and returns every adapter the repo
 * exposes a marker for (polyglot per spec D6).
 */
export function resolveAdaptersForRun(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): readonly LanguageAdapter[] {
  const registry = cli.scope.languages;
  if (typeof opts.language === 'string' && opts.language.length > 0) {
    const canonical = registry.canonicalize(opts.language) ?? opts.language;
    const adapter = registry.get(canonical);
    if (!adapter) {
      throw new ConfigurationError(
        `--language '${opts.language}' is not a registered adapter.`,
      );
    }
    return [adapter];
  }
  const detection = detectLanguages(opts.cwd, registry);
  const adapters: LanguageAdapter[] = [];
  for (const id of detection.adapterIds) {
    const adapter = registry.get(id);
    /* v8 ignore next */
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}
