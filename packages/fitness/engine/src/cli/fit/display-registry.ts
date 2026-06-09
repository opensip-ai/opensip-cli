/**
 * Check display lookups — read from the scope-owned check registry.
 *
 * Display (icon + display name) travels WITH each check on `check.config`
 * (§5.3 separate-domains fold); a pack's authoring map is folded onto its
 * checks via `applyCheckDisplay` at the pack boundary. There is NO per-process
 * merged-display singleton anymore (that was audit finding F3): `getDisplayName`
 * / `getIcon` resolve a slug against the CURRENT run's check registry
 * (`currentCheckRegistry()`), so two concurrent scopes read independent display
 * with no shared mutable state.
 *
 * Slugs with no registered check (or a check that set no display) fall back to
 * kebab-to-title-case for the name and a magnifying-glass emoji for the icon.
 */

import { currentCheckRegistry } from '../../framework/scope-registry.js';

/** Default icon when a check sets none. */
const DEFAULT_ICON = '🔍';

/** Kebab-to-title-case fallback display name for a slug. */
function defaultDisplayName(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Get the display name for a check slug, read from the current scope's check registry. */
export function getDisplayName(slug: string): string {
  return currentCheckRegistry().find(slug)?.config.displayName ?? defaultDisplayName(slug);
}

/** Get the icon for a check slug, read from the current scope's check registry. */
export function getIcon(slug: string): string {
  return currentCheckRegistry().find(slug)?.config.icon ?? DEFAULT_ICON;
}
