import { EnvRegistry, type EnvVarSpec } from './env-registry.js';

/**
 * Snapshot a narrow child-process environment from declared env specs.
 *
 * This keeps child env inheritance behind {@link EnvRegistry}: callers declare
 * the exact parent variables they forward, while host-owned markers are supplied
 * as explicit overrides and never read from the parent process.
 */
export function snapshotEnv(
  specs: readonly EnvVarSpec<unknown>[],
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const registry = new EnvRegistry(specs);
  const env: NodeJS.ProcessEnv = { ...overrides };
  for (const spec of specs) {
    const value = registry.get<string>(spec.canonical);
    if (value !== undefined) env[spec.canonical] = value;
  }
  return env;
}
