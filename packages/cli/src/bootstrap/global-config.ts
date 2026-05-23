/**
 * global-config — read/write the user-level (`~/.opensip-tools/config.yml`)
 * config that holds the cloud API key and per-user defaults.
 *
 * Lives in `bootstrap/` because the pre-action hook reads it on every
 * invocation: `mergeConfigDefaults` falls back to the saved API key when
 * neither `--api-key` nor `OPENSIP_API_KEY` is present. Previously the
 * bootstrap path imported this from `commands/configure.ts`, inverting
 * the startup → command direction; the prompt+UX wrapper still lives
 * there but reads I/O through this module (audit 2026-05-23 M3).
 *
 * The file is YAML and is `chmod 0o600` on write — it stores a secret.
 * Reads are tolerant of any failure (missing dir, malformed YAML); the
 * pre-action hook treats absence and corruption the same as "no key
 * configured".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** User-level OpenSIP root directory. */
export const OPENSIP_DIR = join(homedir(), '.opensip-tools');
/** User-level config file path. */
export const GLOBAL_CONFIG_PATH = join(OPENSIP_DIR, 'config.yml');

/**
 * Shape of `~/.opensip-tools/config.yml`. Open-ended on purpose — future
 * per-user defaults (theme, last-used recipe, telemetry opt-in) can land
 * here without a contract change.
 */
export interface GlobalConfig {
  apiKey?: string;
  [key: string]: unknown;
}

/**
 * Read the user-level global config. Returns `{}` on any failure
 * (missing file, malformed YAML, I/O error) — the merge step treats
 * absence and "everything default" the same.
 */
export function readGlobalConfig(): GlobalConfig {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(GLOBAL_CONFIG_PATH, 'utf8');
    return (parseYaml(raw) as GlobalConfig) ?? {};
  } catch {
    return {};
  }
}

/**
 * Persist the user-level global config. Creates the parent directory if
 * it doesn't exist, writes YAML, and tightens permissions to `0o600`.
 */
export function writeGlobalConfig(config: GlobalConfig): void {
  if (!existsSync(OPENSIP_DIR)) {
    mkdirSync(OPENSIP_DIR, { recursive: true });
  }
  writeFileSync(GLOBAL_CONFIG_PATH, stringifyYaml(config), 'utf8');
  chmodSync(GLOBAL_CONFIG_PATH, 0o600);
}

/**
 * Resolve the OpenSIP Cloud API key from the highest-precedence source
 * available. Resolution order:
 *
 *   1. CLI flag (`--api-key`).
 *   2. Environment variable (`OPENSIP_API_KEY`).
 *   3. User-level global config (`~/.opensip-tools/config.yml#apiKey`).
 *
 * The pre-action hook calls this for the global merge step; the
 * `configure` command calls it for the "current key" hint at the
 * prompt.
 */
export function resolveApiKey(cliFlag?: string): string | undefined {
  if (cliFlag) return cliFlag;
  if (process.env.OPENSIP_API_KEY) return process.env.OPENSIP_API_KEY;
  const config = readGlobalConfig();
  return config.apiKey ?? undefined;
}
