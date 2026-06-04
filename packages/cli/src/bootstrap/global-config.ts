// @fitness-ignore-file error-handling-quality -- readGlobalConfig returns {} on any failure by documented contract (absent file and "everything default" are equivalent to the merge step); writeGlobalConfig's inner unlink is cleanup-of-cleanup where the meaningful rename error is already thrown on the next line.
// @fitness-ignore-file unbounded-memory -- reads ~/.opensip-tools/config.yml, a small user-config file bounded by configuration shape
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

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** User-level OpenSIP root directory. */
const OPENSIP_DIR = join(homedir(), '.opensip-tools');
/** User-level config file path. */
export const GLOBAL_CONFIG_PATH = join(OPENSIP_DIR, 'config.yml');

/**
 * Shape of `~/.opensip-tools/config.yml`. Open-ended on purpose — future
 * per-user defaults (theme, last-used recipe, telemetry opt-in) can land
 * here without a contract change.
 */
export interface GlobalConfig {
  apiKey?: string;
  /**
   * User-level OpenSIP Cloud signal-sync control (ADR-0008). This is the
   * machine-wide privacy opt-out: `cloud.sync: false` here disables signal
   * sync for every project run from this account, regardless of any project's
   * own `cli.cloud:` setting. `endpoint` overrides the cloud URL per user.
   */
  cloud?: { sync?: boolean; endpoint?: string };
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
 * it doesn't exist, then writes via a same-directory temp file with mode
 * `0o600` set at creation time and atomically renames into place.
 *
 * Why temp + rename instead of writeFile + chmod: writeFileSync would
 * create the file using the process's umask (commonly 0o644), leaving a
 * race window during which another local user could read the API key
 * before chmodSync(..., 0o600) tightens permissions. openSync with mode
 * 0o600 + O_EXCL ('wx') sets the permission atomically with the inode
 * creation, and rename publishes the fully-written file in one step so
 * readers never observe a partial file either.
 */
export function writeGlobalConfig(config: GlobalConfig): void {
  if (!existsSync(OPENSIP_DIR)) {
    mkdirSync(OPENSIP_DIR, { recursive: true });
  }
  const tmpPath = join(OPENSIP_DIR, `.config-${randomBytes(6).toString('hex')}.yml.tmp`);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeSync(fd, stringifyYaml(config), 0, 'utf8');
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, GLOBAL_CONFIG_PATH);
  } catch (error) {
    // Clean up the temp file on rename failure so it doesn't linger.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Swallow secondary failure — original error is the one that matters.
    }
    throw error;
  }
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

/** Read + validate the user-level `cloud:` block, defensively. */
function readUserCloudConfig(): { sync?: boolean; endpoint?: string } | undefined {
  const raw = readGlobalConfig().cloud;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { sync?: boolean; endpoint?: string } = {};
  if (typeof r.sync === 'boolean') out.sync = r.sync;
  if (typeof r.endpoint === 'string') out.endpoint = r.endpoint;
  return out.sync === undefined && out.endpoint === undefined ? undefined : out;
}

/**
 * Resolve the effective cloud config for a run by layering the user-level
 * cloud block (`~/.opensip-tools/config.yml#cloud`) over the project-level
 * `cli.cloud:` block — the missing piece behind audit P0-2, where the
 * documented user opt-out was read for the API key but never for `cloud`.
 *
 * Semantics (a data-egress control, so opt-out is sticky):
 *   - `sync` is `false` if EITHER the user (privacy opt-out) or the project
 *     (policy opt-out) sets it `false` — the more restrictive wins, neither
 *     silently overrides the other. Otherwise the user's explicit value, then
 *     the project's.
 *   - `endpoint` takes the user override, then the project's.
 *   - the per-invocation `--no-cloud` flag overrides everything (applied
 *     separately, in resolveSignalSink's `noCloud`).
 */
export function resolveEffectiveCloudConfig(
  projectCloud?: { readonly sync?: boolean; readonly endpoint?: string },
): { sync?: boolean; endpoint?: string } | undefined {
  const userCloud = readUserCloudConfig();
  if (!userCloud && !projectCloud) return undefined;
  const out: { sync?: boolean; endpoint?: string } = {};
  const sync =
    userCloud?.sync === false || projectCloud?.sync === false
      ? false
      : userCloud?.sync ?? projectCloud?.sync;
  const endpoint = userCloud?.endpoint ?? projectCloud?.endpoint;
  if (sync !== undefined) out.sync = sync;
  if (endpoint !== undefined) out.endpoint = endpoint;
  return out.sync === undefined && out.endpoint === undefined ? undefined : out;
}
