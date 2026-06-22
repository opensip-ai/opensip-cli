/**
 * Best-effort load of the resolved `yagni:` config block from scope or YAML.
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
    graphMode: parsed.graphMode ?? DEFAULT_YAGNI_CONFIG.graphMode,
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
  const scoped = currentScope()?.toolConfig?.yagni;
  if (isPlainObject(scoped)) {
    const parsed = YagniConfigSchema.safeParse(scoped);
    if (parsed.success) return mergeDefaults(parsed.data);
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
