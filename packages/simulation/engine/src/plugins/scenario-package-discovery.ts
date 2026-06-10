/**
 * @fileoverview The `plugins.{scenarioPackages,autoDiscoverScenarios,packageScopes}`
 * preference reader.
 *
 * Scenario-pack discovery + resolution (the `<scope>/scenarios-*` name-pattern
 * walk, scope merging, explicit-name resolution, the single-core guard) lives in
 * the GENERIC capability substrate (`@opensip-tools/core`) now. This module keeps
 * only the sim-side reader for the documented config keys — sim resolves its own
 * preference without depending on `@opensip-tools/config`, then hands the result
 * to the generic loader.
 */

import { join } from 'node:path';

import { readYamlFile } from '@opensip-tools/core';

const CONFIG_FILENAME = 'opensip-tools.config.yml';

/**
 * Read `plugins.scenarioPackages`, `plugins.autoDiscoverScenarios`, and
 * `plugins.packageScopes` from the project's opensip-tools.config.yml without a
 * full schema parse. Mirrors the inline-yaml-read pattern used by
 * `readProjectPluginsList()`.
 */
export function readScenarioPackagePreferences(projectDir: string): {
  readonly scenarioPackages?: readonly string[];
  readonly autoDiscoverScenarios?: boolean;
  readonly packageScopes?: readonly string[];
} {
  const configPath = join(projectDir, CONFIG_FILENAME);
  const doc = readYamlFile(configPath);
  if (!doc || typeof doc !== 'object') return {};
  const plugins = (doc as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== 'object') return {};
  const p = plugins as Record<string, unknown>;
  const result: {
    scenarioPackages?: readonly string[];
    autoDiscoverScenarios?: boolean;
    packageScopes?: readonly string[];
  } = {};
  if (Array.isArray(p.scenarioPackages)) {
    result.scenarioPackages = p.scenarioPackages.filter((v): v is string => typeof v === 'string');
  }
  if (typeof p.autoDiscoverScenarios === 'boolean') {
    result.autoDiscoverScenarios = p.autoDiscoverScenarios;
  }
  if (Array.isArray(p.packageScopes)) {
    result.packageScopes = p.packageScopes.filter((v): v is string => typeof v === 'string');
  }
  return result;
}
