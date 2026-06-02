// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (registry items / small analysis results)
/**
 * @fileoverview Check resolution for fitness recipes.
 *
 * Resolves recipe check selectors (explicit / pattern / tags / all) into
 * concrete check-key lists. The selection algorithm itself lives once in
 * `@opensip-tools/core` (`resolveSelector`); this module wires fitness's
 * registry, `minimatch`, and namespaced-slug reverse-lookup into it. The
 * per-arm semantics are unchanged from the previous hand-rolled switch.
 */

import { resolveSelector, type ResolveSelectorOptions } from '@opensip-tools/core'
import { minimatch } from 'minimatch'

import type { CheckSelector } from './types.js'
import type { CheckRegistry } from '../framework/registry.js'

/**
 * Build the glob match targets for a check key: the key itself, its bare
 * slug (namespace stripped), and `tag/bareSlug` targets for each of the
 * check's tags. This is fitness's `keysOf` accessor for the core resolver.
 */
function buildMatchTargets(slug: string, registry?: CheckRegistry): string[] {
  const targets = [slug]
  // Extract bare slug from namespaced key (e.g., 'builtin:no-eval' → 'no-eval')
  const bareSlug = slug.includes(':') ? slug.split(':').pop()! : slug
  if (bareSlug !== slug) targets.push(bareSlug)

  if (registry) {
    const check = registry.getBySlug(slug)
    if (check?.config.tags) {
      for (const tag of check.config.tags) {
        targets.push(`${tag}/${bareSlug}`)
      }
    }
  }
  return targets
}

/**
 * Resolve a CheckSelector to a list of check keys from the registry.
 *
 * Delegates to core's generic `resolveSelector`, supplying fitness's
 * registry-backed hooks:
 * - the universe is `registry.listSlugs()` (each key becomes a Registerable item);
 * - `keysOf` is `buildMatchTargets` (key + bare slug + tag/slug targets);
 * - the `pattern` / `all` matcher is `minimatch` (kept a fitness dependency);
 * - `resolveExplicit` is the bare-slug → namespaced-key reverse lookup
 *   (mirrors the previous `resolveExplicitSelector`: exact key first, then
 *   `getBySlug` + `endsWith(':'+id)`);
 * - the `tags` arm routes through core's built-in tag-set intersection over
 *   `check.config.tags` (`tagsOf` reads the registry), matching the previous
 *   `resolveTagsSelector` exactly.
 */
export function resolveChecks(selector: CheckSelector, registry: CheckRegistry): readonly string[] {
  const items = registry.listSlugs().map((key) => ({ id: key, name: key }))

  const opts: ResolveSelectorOptions<(typeof items)[number], CheckSelector> = {
    keysOf: (item) => buildMatchTargets(item.id, registry),
    tagsOf: (item) => registry.getBySlug(item.id)?.config.tags ?? [],
    match: (target, pattern) => minimatch(target, pattern, { nocase: false }),
    // Bare slug → namespaced-key reverse lookup; otherwise no resolution.
    resolveExplicit: (id) =>
      !id.includes(':') && registry.getBySlug(id)
        ? (registry.listSlugs().find((s) => s.endsWith(`:${id}`)) ?? id)
        : undefined,
  }

  // The core resolver reads the `explicit` arm's request list from `ids`;
  // fitness's historical field is `checkIds`. Normalize at the boundary so
  // recipe literals (`{ type: 'explicit', checkIds: [...] }`) stay valid.
  const normalized =
    selector.type === 'explicit' ? { ...selector, ids: selector.checkIds } : selector

  return resolveSelector(normalized as CheckSelector, items, opts).map((item) => item.id)
}

/** Result of validating check references against the registry */
interface CheckReferenceValidation {
  valid: string[]
  missing: string[]
}

/** Validate a list of check IDs against known IDs, returning valid and missing sets */
export function validateCheckReferences(
  checkIds: readonly string[],
  allCheckIds: readonly string[],
): CheckReferenceValidation {
  const existingSet = new Set(allCheckIds)
  const valid: string[] = []
  const missing: string[] = []

  for (const id of checkIds) {
    if (existingSet.has(id)) {
      valid.push(id)
    } else {
      missing.push(id)
    }
  }

  return { valid, missing }
}
