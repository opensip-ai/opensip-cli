/** Canonical graph configuration loader for read-port composition. */

import { loadGraphConfig } from '../cli/graph-config.js';

import type { GraphConfig } from '../types.js';

/**
 * Load the same scope-resolved graph configuration used by graph producers.
 * Keeping this narrow facade in graph prevents consumers from importing CLI
 * orchestration internals just to compose freshness verification.
 */
export function loadGraphReadConfig(projectRoot: string, configPath?: string): GraphConfig {
  return loadGraphConfig(projectRoot, configPath);
}
