/**
 * yagni-config — load the resolved `yagni:` block of `opensip-cli.config.yml`
 * into a {@link YagniConfig}.
 *
 * ADR-0023, Phase 4: the resolved `yagni:` block rides on the per-run scope
 * (`scope.toolConfig.yagni`) — the host already strict-validated +
 * precedence-resolved (flag > env > file > defaults) the whole document before
 * dispatch, using yagni's own namespaced {@link YagniConfigSchema} (the same
 * schema yagni contributes via `yagniConfigDeclaration`). So when a scope is
 * present (every CLI dispatch path goes through the pre-action hook) this returns
 * the SCOPE value and does NOT re-read YAML — mirroring `loadGraphConfig` /
 * `readSimulationRecipe`. The YAML read below is the fallback for a scope-less
 * direct caller (a unit test driving `loadYagniConfig`); there it stays
 * best-effort: a missing config, malformed YAML, an absent `yagni:` key, or a
 * block that fails the schema all collapse to the merged defaults.
 *
 * This loader is the yagni peer of graph's `graph-config.ts` and sim's
 * `sim-config.ts` config-loader bridges — it is allowlisted in the
 * `dogfood-one-config-document-ratchet` check's sanctioned config readers for
 * exactly this reason.
 */

import { currentScope, readYamlFile, resolveProjectConfigPath } from '@opensip-cli/core';

import { DEFAULT_YAGNI_CONFIG } from '../types/yagni-config.js';

import { YagniConfigSchema } from './yagni-config-schema.js';

import type { YagniConfig } from '../types/yagni-config.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeDefaults(parsed: YagniConfig): YagniConfig {
  return {
    failOnErrors: parsed.failOnErrors ?? DEFAULT_YAGNI_CONFIG.failOnErrors,
    failOnWarnings: parsed.failOnWarnings ?? DEFAULT_YAGNI_CONFIG.failOnWarnings,
    defaultMinConfidence: parsed.defaultMinConfidence ?? DEFAULT_YAGNI_CONFIG.defaultMinConfidence,
    includeTests: parsed.includeTests ?? DEFAULT_YAGNI_CONFIG.includeTests,
    ...(parsed.disabledDetectors === undefined
      ? {}
      : { disabledDetectors: parsed.disabledDetectors }),
    ...(parsed.detectorSettings === undefined ? {} : { detectorSettings: parsed.detectorSettings }),
  };
}

/**
 * Load the `yagni:` namespace for a run. Prefers the host-resolved scope value.
 */
export function loadYagniConfig(cwd: string, explicitPath?: string): YagniConfig {
  // Scope-first: the resolved, strict-validated `yagni:` block (env/flag
  // precedence already folded in by the composer). Present on every CLI dispatch
  // path; absent only off-CLI (direct unit-test calls), where we fall back to the
  // YAML read below.
  const scope = currentScope();
  const scoped = scope?.toolConfig?.yagni;
  if (isPlainObject(scoped)) {
    const parsed = YagniConfigSchema.safeParse(scoped);
    if (parsed.success) return mergeDefaults(parsed.data);
  }
  if (scope !== undefined) {
    // A scope-bound dispatch has already had its config composed. If there is no
    // resolved `yagni:` block, do not perform a second YAML read; use the merged
    // tool defaults instead (mirrors loadGraphConfig / readSimulationRecipe).
    return mergeDefaults({});
  }

  const configPath = resolveProjectConfigPath(cwd, explicitPath);
  const doc = readYamlFile(configPath);
  if (!isPlainObject(doc) || !isPlainObject(doc.yagni)) {
    return mergeDefaults({});
  }
  const parsed = YagniConfigSchema.safeParse(doc.yagni);
  if (!parsed.success) return mergeDefaults({});
  return mergeDefaults(parsed.data);
}
