/**
 * global-config — read/write the user-level (`~/.opensip-cli/config.yml`)
 * config that holds the cloud API key and per-user defaults.
 *
 * User-scoped config I/O is tool-agnostic, so it lives in the config layer
 * (relocated here from the CLI's `bootstrap/`, ADR-0023). The CLI's
 * pre-action hook reads it on every invocation (`mergeConfigDefaults` falls back
 * to the saved API key when neither `--api-key` nor `OPENSIP_API_KEY` is
 * present), and the `configure` command's prompt+UX wrapper — which stays in
 * `cli/commands` — reads/writes I/O through this module.
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

import {
  EnvRegistry,
  isPlainRecord,
  withFileLock,
  type EnvVarSpec,
  ValidationError,
} from '@opensip-cli/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { configErrorCatalog } from '../errors/config-error-catalog.js';
import {
  userTrustPolicySchema,
  type UserTrustPolicyDocument,
} from '../policy/trust-policy-schema.js';

const POLICY_DOCUMENT_INVALID = configErrorCatalog.require('CONFIG.POLICY.USER_DOCUMENT_INVALID');

/**
 * Config-layer environment variables (§5.12). Declared as an
 * immutable spec table read through the {@link EnvRegistry} primitive, so the env
 * surface is governed and documentable (the `env-via-registry` guardrail forbids
 * raw `process.env` reads). Re-exported for the generated env-surface doc.
 */
export const CONFIG_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OPENSIP_API_KEY',
    docs: 'OpenSIP Cloud API key. Overrides the apiKey stored in ~/.opensip-cli/config.yml.',
  },
];
const CONFIG_ENV = new EnvRegistry(CONFIG_ENV_SPECS);

/** User-level OpenSIP root directory. */
const OPENSIP_DIR = join(homedir(), '.opensip-cli');
/** User-level config file path. */
export const GLOBAL_CONFIG_PATH = join(OPENSIP_DIR, 'config.yml');

/** Same-directory lockfile serializing global-config read-modify-write cycles. */
const GLOBAL_CONFIG_LOCK_PATH = join(OPENSIP_DIR, '.config.yml.lock');
const GLOBAL_CONFIG_LOCK_POLICY = Object.freeze({
  waitMs: 2000,
  staleMs: 30_000,
  heartbeatMs: 5000,
});

/**
 * Serialize a global-config read-modify-write cycle. `writeGlobalConfig`'s
 * temp+rename is atomic against torn READS, but two concurrent RMW cycles
 * (e.g. `policy trust` in one terminal, `configure` in another) still lose
 * the first writer's change to the second's whole-file overwrite. Every
 * mutation that reads the config before writing it back must run inside this
 * lock, with the read INSIDE `fn`.
 */
export function withGlobalConfigLock<T>(fn: () => T): T {
  if (!existsSync(OPENSIP_DIR)) {
    mkdirSync(OPENSIP_DIR, { recursive: true });
  }
  return withFileLock(
    GLOBAL_CONFIG_LOCK_PATH,
    {
      policy: GLOBAL_CONFIG_LOCK_POLICY,
      resource: 'runtime',
      operation: 'global-config-rmw',
    },
    fn,
  );
}

/**
 * Shape of `~/.opensip-cli/config.yml`. Open-ended on purpose — future
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
  policy?: unknown;
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
    const parsed: unknown = parseYaml(raw);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Result of reading the user-level trust-policy block without throwing. */
export interface ReadGlobalTrustPolicyResult {
  readonly policy?: UserTrustPolicyDocument;
  readonly error?: string;
}

/**
 * Read + validate the user-level `policy:` block without throwing. The USER
 * document is the one tier whose policy may carry `trustedCapabilityPacks`
 * (the single out-of-repo capability trust surface); the project tier stays on
 * the narrower strict schema, which hard-rejects the field.
 */
export function readGlobalTrustPolicy(): ReadGlobalTrustPolicyResult {
  const raw = readGlobalConfig().policy;
  if (raw === undefined) return {};
  const parsed = userTrustPolicySchema.safeParse(raw);
  if (parsed.success) return { policy: parsed.data };
  const summary = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(policy)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return { error: summary };
}

/**
 * Upsert one capability trust grant on the user-level global config (the
 * single out-of-repo capability trust surface — plan 09 Phase 3).
 *
 * @throws {Error} when the existing `policy:` block is invalid — a grant must
 * never be written next to (or clobber) a policy document the resolver would
 * reject; the user fixes the file first.
 */
export function grantCapabilityTrust(grant: {
  readonly id: string;
  readonly manifestHash: string;
  readonly grantedAt?: string;
}): void {
  withGlobalConfigLock(() => {
    const config = readGlobalConfig();
    const existing = readGlobalTrustPolicy();
    if (existing.error !== undefined) {
      throw new ValidationError(
        `user-level policy block is invalid (${existing.error}); fix ${GLOBAL_CONFIG_PATH} before granting trust`,
        {
          code: POLICY_DOCUMENT_INVALID.code,
          definition: POLICY_DOCUMENT_INVALID,
          metadata: { condition: 'existing-policy-invalid' },
        },
      );
    }
    const policy: UserTrustPolicyDocument = existing.policy ?? {};
    const grants = (policy.trustedCapabilityPacks ?? []).filter((entry) => entry.id !== grant.id);
    const nextPolicy = userTrustPolicySchema.safeParse({
      ...policy,
      trustedCapabilityPacks: [...grants, { ...grant }],
    });
    if (!nextPolicy.success) {
      const summary = nextPolicy.error.issues.map((issue) => issue.message).join('; ');
      throw new ValidationError(
        `capability trust grant would make the user policy invalid: ${summary}`,
        {
          code: POLICY_DOCUMENT_INVALID.code,
          definition: POLICY_DOCUMENT_INVALID,
          metadata: { condition: 'grant-would-invalidate' },
        },
      );
    }
    writeGlobalConfig({
      ...config,
      policy: nextPolicy.data,
    });
  });
}

/**
 * Remove a capability trust grant from the user-level global config. Returns
 * `false` when no grant with that id existed (including when the policy block
 * is absent or invalid — revocation never throws on a broken document; the
 * broken document already grants nothing).
 */
export function revokeCapabilityTrust(id: string): boolean {
  return withGlobalConfigLock(() => {
    const config = readGlobalConfig();
    const existing = readGlobalTrustPolicy();
    // @silent-ok — documented contract (see JSDoc): false = nothing to revoke.
    if (existing.error !== undefined || existing.policy === undefined) return false;
    const grants = existing.policy.trustedCapabilityPacks ?? [];
    const kept = grants.filter((entry) => entry.id !== id);
    // @silent-ok — documented contract (see JSDoc): false = nothing to revoke.
    if (kept.length === grants.length) return false;
    writeGlobalConfig({
      ...config,
      policy: { ...existing.policy, trustedCapabilityPacks: kept },
    });
    return true;
  });
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
 *   3. User-level global config (`~/.opensip-cli/config.yml#apiKey`).
 *
 * The pre-action hook calls this for the global merge step; the
 * `configure` command calls it for the "current key" hint at the
 * prompt.
 */
export function resolveApiKey(cliFlag?: string): string | undefined {
  if (cliFlag) return cliFlag;
  // Env override (read through the registry; truthy so an empty value falls
  // through to the config file, byte-identical to the prior `process.env` check).
  const fromEnv = CONFIG_ENV.get<string>('OPENSIP_API_KEY');
  if (fromEnv) return fromEnv;
  const config = readGlobalConfig();
  return typeof config.apiKey === 'string' ? config.apiKey : undefined;
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
 * cloud block (`~/.opensip-cli/config.yml#cloud`) over the project-level
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
export function resolveEffectiveCloudConfig(projectCloud?: {
  readonly sync?: boolean;
  readonly endpoint?: string;
}): { sync?: boolean; endpoint?: string } | undefined {
  const userCloud = readUserCloudConfig();
  if (!userCloud && !projectCloud) return undefined;
  const out: { sync?: boolean; endpoint?: string } = {};
  const sync =
    userCloud?.sync === false || projectCloud?.sync === false
      ? false
      : (userCloud?.sync ?? projectCloud?.sync);
  const endpoint = userCloud?.endpoint ?? projectCloud?.endpoint;
  if (sync !== undefined) out.sync = sync;
  if (endpoint !== undefined) out.endpoint = endpoint;
  return out.sync === undefined && out.endpoint === undefined ? undefined : out;
}
