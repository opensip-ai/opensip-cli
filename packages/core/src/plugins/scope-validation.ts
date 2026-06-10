/**
 * @fileoverview Shared npm-scope validation + resolution for scoped plugin
 * auto-discovery (scenario packs, future package families).
 *
 * Discovery code maps a scope string to `node_modules/<scope>/` and
 * scans for packages. Untrusted scope strings reach `path.join`, so we
 * enforce strict npm-scope syntax before they're used as path
 * segments. A stray `..` or `/` would otherwise scan the wrong
 * directory.
 *
 * Hoisted into core so every scoped discovery surface enforces the
 * same invariant. The `@opensip-tools/scenarios-*` discovery in sim
 * flows through this helper.
 */

import { logger } from '../lib/logger.js';

/**
 * npm scope syntax: `@` followed by a kebab-case identifier. We anchor
 * strictly because scope strings end up in `path.join('node_modules', scope)`
 * — a stray `..` or `/` would scan the wrong directory.
 */
export const VALID_NPM_SCOPE_REGEX = /^@[a-z0-9][a-z0-9._-]*$/;

/**
 * Resolve the effective list of npm scopes to scan: the platform
 * default is always included; customer additions are appended after
 * deduplication and format validation. Invalid scope strings are
 * dropped with a structured warning rather than throwing — consistent
 * with how discovery handles unresolved explicit packages elsewhere.
 *
 * @param defaultScope  The platform default (e.g. `@opensip-tools`)
 * @param extraScopes   Customer-configured additions
 * @param evt           Log event name to use when warning about invalid
 *                       entries — lets each caller emit a domain-specific
 *                       event name (`plugin.scenario_package.invalid_scope`).
 */
export function resolveScopes(
  defaultScope: string,
  extraScopes: readonly string[],
  evt: string,
): readonly string[] {
  const out: string[] = [defaultScope];
  const seen = new Set<string>(out);
  for (const scope of extraScopes) {
    if (!VALID_NPM_SCOPE_REGEX.test(scope)) {
      logger.warn({
        evt,
        module: 'core:plugins',
        scope,
        msg: `plugins.packageScopes entry "${scope}" is not a valid npm scope (expected "@kebab-case") — skipping`,
      });
      continue;
    }
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}
