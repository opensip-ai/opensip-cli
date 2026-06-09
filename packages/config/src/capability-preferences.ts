/**
 * @fileoverview One descriptor-driven capability-preference resolver (§5.3,
 * Phase 3).
 *
 * Three bespoke readers parse three key-sets today — fitness's
 * `readCheckPackagePreferences` (`plugins.checkPackages`), simulation's
 * `readScenarioPackagePreferences` (`plugins.scenarioPackages` /
 * `autoDiscoverScenarios` / `packageScopes`), and graph's
 * `readGraphAdapterPackagePreferences` (`plugins.graphAdapters` /
 * `autoDiscoverGraphAdapters`). Each domain's discovery descriptor maps domain →
 * config keys (`descriptor.configKeys`), so this one resolver replaces all three
 * WITHOUT renaming a single key — the documented `opensip-tools.config.yml`
 * surface is byte-identical, no migration.
 *
 * Reads from the raw `plugins` block of the project config (the same block the
 * three readers read). Lives in `@opensip-tools/config` because reading config is
 * a config-layer concern; the generic substrate (core) receives the RESOLVED
 * preferences, staying config-pure.
 */

import { isRecord, resolveScopes } from '@opensip-tools/core';

import type { CapabilityDiscoveryDescriptor } from '@opensip-tools/core';

/** Resolved discovery preferences for one domain — the shape the substrate consumes. */
export interface CapabilityPreferences {
  /** Explicit package-name list (present → the substrate skips/augments auto per its mode). */
  readonly packages?: readonly string[];
  /** Auto-discovery enabled. Documented default: ON unless explicitly `false`. */
  readonly autoDiscover: boolean;
  /** name-pattern mode: the resolved+validated scopes to scan (default ∪ customer). */
  readonly scopes?: readonly string[];
}

/** Read a key as a `string[]`, filtering non-strings; `undefined` when the key is not an array. */
function stringArrayAt(record: Record<string, unknown>, key: string | undefined): readonly string[] | undefined {
  if (key === undefined) return undefined;
  const value = record[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/**
 * Resolve a domain's discovery preferences from the project config's `plugins`
 * block through the keys its descriptor declares.
 *
 * @param descriptor   The domain's discovery descriptor (supplies `configKeys` + mode).
 * @param pluginsConfig The raw `plugins` block from `opensip-tools.config.yml`
 *   (or anything — a non-object is treated as "no preferences declared").
 */
export function resolveCapabilityPreferences(
  descriptor: CapabilityDiscoveryDescriptor,
  pluginsConfig: unknown,
): CapabilityPreferences {
  const plugins = isRecord(pluginsConfig) ? pluginsConfig : {};
  const keys = descriptor.configKeys;

  // Explicit list: present (even empty) → the substrate honors it; absent → undefined.
  const packages = stringArrayAt(plugins, keys.packages);

  // Auto-discover: documented default ON; only an explicit boolean `false` disables it.
  const autoRaw = keys.autoDiscover === undefined ? undefined : plugins[keys.autoDiscover];
  const autoDiscover = typeof autoRaw === 'boolean' ? autoRaw : true;

  // Scopes (name-pattern only): merge the descriptor's default scopes with any
  // customer-configured additions, validated + deduped — exactly the
  // `resolveScopes(DEFAULT_SCOPE, packageScopes)` the sim reader did.
  const scopes = resolveNamePatternScopes(descriptor, stringArrayAt(plugins, keys.scopes) ?? []);

  return {
    ...(packages === undefined ? {} : { packages }),
    autoDiscover,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

/** Merge default + customer scopes for name-pattern mode; `undefined` for marker mode. */
function resolveNamePatternScopes(
  descriptor: CapabilityDiscoveryDescriptor,
  customerScopes: readonly string[],
): readonly string[] | undefined {
  if (descriptor.discovery.mode !== 'name-pattern') return undefined;
  const [primary = '@opensip-tools', ...restDefaults] = descriptor.discovery.defaultScopes;
  return resolveScopes(primary, [...restDefaults, ...customerScopes], 'plugin.capability.invalid_scope');
}
