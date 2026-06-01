/**
 * Merged check display map — owns the per-process registry of
 * `[icon, displayName]` tuples contributed by every loaded check
 * package via the `FitPluginExports.checkDisplay` field.
 *
 * Lifecycle: `mergeCheckDisplay()` is called by the check-loader as
 * each package loads; `rebuildDisplayLookups()` is called once after
 * `ensureChecksLoaded()` finishes so the public `getDisplayName()` /
 * `getIcon()` accessors resolve through the merged map.
 *
 * The map state is module-singleton because two external consumers
 * (`FitView` in `opensip-tools`, `dashboard.ts` in this package)
 * read the accessors directly. See `check-loader.ts`'s lifecycle
 * comment for the broader rationale.
 */

import { logger } from '@opensip-tools/core';

import type { CheckDisplayEntry } from '@opensip-tools/core';

/**
 * Merged display map contributed by every loaded check package via the
 * FitPluginExports.checkDisplay field. Each package owns the slugs it
 * registers; on collision the last package loaded wins (no package is
 * privileged). Slugs without an entry fall back to kebab-to-title-case.
 */
const mergedCheckDisplay = new Map<string, CheckDisplayEntry>();

/** Lifecycle singleton, set by `rebuildDisplayLookups()` after
 * `ensureChecksLoaded`; read by `buildFitDoneResult`. */
let getCheckDisplayName: (slug: string) => string = defaultDisplayName;
/** Lifecycle singleton, set by `rebuildDisplayLookups()` after
 * `ensureChecksLoaded`; read via the exported `getIcon` accessor. */
let getCheckIcon: (slug: string) => string = (_slug: string) => '🔍';

function defaultDisplayName(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Recomputes the check-slug → display-name/icon lookup closures from the merged display map. */
export function rebuildDisplayLookups(): void {
  getCheckDisplayName = (slug) => {
    const entry = mergedCheckDisplay.get(slug);
    return entry ? entry[1] : defaultDisplayName(slug);
  };
  getCheckIcon = (slug) => {
    const entry = mergedCheckDisplay.get(slug);
    return entry ? entry[0] : '🔍';
  };
}

/**
 * Merge a check package's display map into the CLI-wide registry.
 *
 * Validates each entry is a `[icon, name]` tuple before accepting it —
 * a malformed `checkDisplay` export from a third-party package shouldn't
 * crash the run. Bad entries are dropped silently with a debug log so
 * the user still gets a (worse-formatted) result rather than a hang.
 *
 * On collision, last package loaded wins. That's intentional: it lets
 * a downstream package override a base package's display name without
 * having to touch the original.
 */
export function mergeCheckDisplay(packageName: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [slug, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
    ) {
      mergedCheckDisplay.set(slug, [entry[0], entry[1]] as const);
    } else {
      logger.debug({
        evt: 'cli.check_package.bad_display_entry',
        module: 'cli:fit',
        packageName,
        slug,
      });
    }
  }
}

/** Get display name for a check slug (available after ensureChecksLoaded). */
export function getDisplayName(slug: string): string {
  return getCheckDisplayName(slug);
}

/** Get icon for a check slug (available after ensureChecksLoaded). */
export function getIcon(slug: string): string {
  return getCheckIcon(slug);
}
