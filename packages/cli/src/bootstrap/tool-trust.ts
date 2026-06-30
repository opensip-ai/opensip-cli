import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  isPathInside,
  isPlainRecord,
  logger,
  readYamlFile,
  resolveProjectPaths,
  resolveUserPaths,
} from '@opensip-cli/core';

/**
 * tool-trust — executable-tool trust policies for project-local and installed
 * npm tools (release launch, Phase 3 Task 3.2; audit remediation).
 *
 * A `project-local` tool is authored code under `<project>/opensip-cli/…`
 * that changes with the repo (§5.2.1). Running it imports arbitrary code
 * from the working tree, so the host MUST make the trust decision explicit
 * rather than load-by-presence.
 *
 * Policy for launch (signed off): **deny-by-default for non-interactive
 * runs; admit when an explicit project/user action recorded trust.** Project
 * authored tools use committed `tools.trusted`; managed npm installs use a
 * per-host trust record; env allowlists remain override/incident-response
 * mechanisms:
 *
 *   OPENSIP_CLI_ALLOW_PROJECT_TOOLS="my-audit, my-lint"    # override by id
 *   OPENSIP_CLI_ALLOW_PROJECT_TOOLS="*"                    # override all
 *
 * The decision is made BEFORE the tool's module is imported: a disallowed
 * project-local tool is fail-closed (exit 5) without its code ever running.
 */

/**
 * Environment variable carrying the project-local tool allowlist. Read
 * once per decision (cheap), never cached, so a test can set/unset it
 * around a single call.
 */
export const PROJECT_TOOL_ALLOWLIST_ENV = 'OPENSIP_CLI_ALLOW_PROJECT_TOOLS';

/**
 * Environment variable carrying the installed-npm tool allowlist. Empty/unset
 * ⇒ deny-by-default for ambient `node_modules` discovery (paired with
 * {@link isInstalledToolTrusted}).
 */
export const INSTALLED_TOOL_ALLOWLIST_ENV = 'OPENSIP_CLI_ALLOW_INSTALLED_TOOLS';

/**
 * Environment variable carrying the capability-pack allowlist. Unlike the older
 * tool allowlists, this launch surface is exact-name only: wildcard `*` is not
 * honored.
 */
export const CAPABILITY_PACK_ALLOWLIST_ENV = 'OPENSIP_CLI_ALLOW_CAPABILITY_PACKS';

const TOOL_TRUST_FILE = 'tool-trust.json';
const TOOL_TRUST_SCHEMA_VERSION = 1;

export type ToolTrustReason =
  | 'bundled'
  | 'managed-install'
  | 'project-config'
  | 'env'
  | 'user-global'
  | 'denied';

export interface InstalledToolTrustRecord {
  readonly toolId: string;
  readonly packageName: string;
  readonly version?: string;
  readonly manifestHash: string;
  readonly installSourcePath: string;
  readonly installedAt: string;
}

interface InstalledToolTrustFile {
  readonly schemaVersion: number;
  readonly installedTools: readonly InstalledToolTrustRecord[];
}

export interface InstalledToolTrustDecision {
  readonly trusted: boolean;
  readonly reason: ToolTrustReason;
}

/**
 * Parse the allowlist env var into a set of permitted tool ids. Empty/
 * unset ⇒ empty set (deny-by-default). The wildcard `'*'` admits all
 * (surfaced via {@link isProjectLocalToolTrusted}).
 */
function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function warnWildcardAllowlist(envVar: string, allow: ReadonlySet<string>): void {
  if (!allow.has('*')) return;
  logger.warn({
    evt: 'cli.trust.wildcard_allowlist',
    envVar,
    deprecated: true,
    detail:
      'DEPRECATED: trust allowlist contains wildcard * — every matching tool runs at full user privilege; ' +
      'this is fault-isolation only, not a sandbox',
  });
}

function warnIgnoredCapabilityWildcard(allow: ReadonlySet<string>): void {
  if (!allow.has('*')) return;
  logger.warn({
    evt: 'cli.trust.capability_wildcard_ignored',
    envVar: CAPABILITY_PACK_ALLOWLIST_ENV,
    detail:
      'OPENSIP_CLI_ALLOW_CAPABILITY_PACKS requires exact package names; wildcard * is ignored',
  });
}

function stringArrayAt(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function trustedToolIdsFromConfigDocument(document: unknown): ReadonlySet<string> {
  if (!isPlainRecord(document)) return new Set();
  const tools = document.tools;
  if (!isPlainRecord(tools)) return new Set();
  return new Set(stringArrayAt(tools, 'trusted'));
}

export function readProjectTrustedToolIds(configPath: string | undefined): ReadonlySet<string> {
  if (configPath === undefined) return new Set();
  return trustedToolIdsFromConfigDocument(readYamlFile(configPath));
}

function installedTrustFileForScope(scope: 'global' | 'project', cwd: string): string {
  const hostDir =
    scope === 'project'
      ? resolveProjectPaths(cwd).pluginsDir('tool')
      : resolveUserPaths().pluginsDir('tool');
  return join(hostDir, TOOL_TRUST_FILE);
}

function readInstalledTrustFile(path: string): InstalledToolTrustFile {
  if (!existsSync(path)) return { schemaVersion: TOOL_TRUST_SCHEMA_VERSION, installedTools: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isPlainRecord(parsed)) {
      return { schemaVersion: TOOL_TRUST_SCHEMA_VERSION, installedTools: [] };
    }
    const records = Array.isArray(parsed.installedTools) ? parsed.installedTools : [];
    return {
      schemaVersion: TOOL_TRUST_SCHEMA_VERSION,
      installedTools: records.filter(isInstalledToolTrustRecord),
    };
  } catch {
    return { schemaVersion: TOOL_TRUST_SCHEMA_VERSION, installedTools: [] };
  }
}

function isInstalledToolTrustRecord(value: unknown): value is InstalledToolTrustRecord {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.toolId === 'string' &&
    typeof value.packageName === 'string' &&
    (value.version === undefined || typeof value.version === 'string') &&
    typeof value.manifestHash === 'string' &&
    typeof value.installSourcePath === 'string' &&
    typeof value.installedAt === 'string'
  );
}

function writeInstalledTrustFile(path: string, file: InstalledToolTrustFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

export function recordInstalledToolTrust(args: {
  readonly scope: 'global' | 'project';
  readonly cwd: string;
  readonly toolId: string;
  readonly packageName: string;
  readonly version?: string;
  readonly manifestHash: string;
  readonly installSourcePath: string;
  readonly installedAt?: Date;
}): void {
  const path = installedTrustFileForScope(args.scope, args.cwd);
  const existing = readInstalledTrustFile(path).installedTools.filter(
    (record) => !(record.toolId === args.toolId && record.packageName === args.packageName),
  );
  const record: InstalledToolTrustRecord = {
    toolId: args.toolId,
    packageName: args.packageName,
    ...(args.version === undefined ? {} : { version: args.version }),
    manifestHash: args.manifestHash,
    installSourcePath: args.installSourcePath,
    installedAt: (args.installedAt ?? new Date()).toISOString(),
  };
  writeInstalledTrustFile(path, {
    schemaVersion: TOOL_TRUST_SCHEMA_VERSION,
    installedTools: [...existing, record],
  });
}

export function removeInstalledToolTrust(args: {
  readonly scope: 'global' | 'project';
  readonly cwd: string;
  readonly toolId: string;
  readonly packageName: string;
}): void {
  const path = installedTrustFileForScope(args.scope, args.cwd);
  const existing = readInstalledTrustFile(path).installedTools;
  const retained = existing.filter(
    (record) => !(record.toolId === args.toolId && record.packageName === args.packageName),
  );
  if (retained.length === existing.length) return;
  writeInstalledTrustFile(path, {
    schemaVersion: TOOL_TRUST_SCHEMA_VERSION,
    installedTools: retained,
  });
}

function recordMatchesInstalledTool(
  record: InstalledToolTrustRecord,
  args: {
    readonly toolId: string;
    readonly packageName: string;
    readonly manifestHash?: string;
  },
): boolean {
  return (
    record.toolId === args.toolId &&
    record.packageName === args.packageName &&
    (args.manifestHash === undefined || record.manifestHash === args.manifestHash)
  );
}

function hasMatchingManagedInstallTrust(args: {
  readonly scope: 'global' | 'project';
  readonly cwd: string;
  readonly toolId: string;
  readonly packageName: string;
  readonly manifestHash?: string;
}): boolean {
  const path = installedTrustFileForScope(args.scope, args.cwd);
  return readInstalledTrustFile(path).installedTools.some((record) =>
    recordMatchesInstalledTool(record, args),
  );
}

function isPackageUnderManagedHost(args: {
  readonly packageDir: string;
  readonly scope: 'global' | 'project';
  readonly cwd: string;
}): boolean {
  const hostDir =
    args.scope === 'project'
      ? resolveProjectPaths(args.cwd).pluginsDir('tool')
      : resolveUserPaths().pluginsDir('tool');
  return isPathInside(args.packageDir, hostDir);
}

export function resolveInstalledToolTrust(args: {
  readonly toolId: string;
  readonly packageName: string;
  readonly packageDir: string;
  readonly manifestHash?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly projectRoot?: string;
  readonly projectTrustedTools?: ReadonlySet<string>;
}): InstalledToolTrustDecision {
  if (isInstalledToolTrusted(args.toolId, args.env)) {
    return { trusted: true, reason: 'env' };
  }
  if (
    args.projectRoot !== undefined &&
    isPackageUnderManagedHost({
      packageDir: args.packageDir,
      scope: 'project',
      cwd: args.projectRoot,
    })
  ) {
    if (
      hasMatchingManagedInstallTrust({
        scope: 'project',
        cwd: args.projectRoot,
        toolId: args.toolId,
        packageName: args.packageName,
        manifestHash: args.manifestHash,
      })
    ) {
      return { trusted: true, reason: 'managed-install' };
    }
    if (args.projectTrustedTools?.has(args.toolId) === true) {
      return { trusted: true, reason: 'project-config' };
    }
  }
  if (
    isPackageUnderManagedHost({
      packageDir: args.packageDir,
      scope: 'global',
      cwd: process.cwd(),
    }) &&
    hasMatchingManagedInstallTrust({
      scope: 'global',
      cwd: process.cwd(),
      toolId: args.toolId,
      packageName: args.packageName,
      manifestHash: args.manifestHash,
    })
  ) {
    return { trusted: true, reason: 'managed-install' };
  }
  return { trusted: false, reason: 'denied' };
}

/**
 * Decide whether a project-local executable tool with the given `id` is
 * trusted to load, under the deny-by-default + allowlist-opt-in policy.
 *
 * **Env governance (pre-scope exception).** The allowlist var is declared as a
 * first-class `EnvVarSpec` in `CLI_ENV_SPECS`
 * (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`, `host-env-specs.ts`) — that declaration
 * is the documentation home, so it appears in the generated env-surface
 * reference. The read here stays on the INJECTED `env` param rather than
 * `hostEnv.get(...)`: this trust check runs at BOOTSTRAP, before any `RunScope`
 * exists, and the injectable seam is what keeps it unit-testable without
 * mutating global `process.env` (the same posture the repo takes for
 * `NODE_OPTIONS`). The `env-via-registry` guardrail is satisfied because this is
 * an injected-param read (`env[...]`), not a raw `process.env.<NAME>` read.
 *
 * @param id The tool's stable id (from its sidecar manifest).
 * @param env The environment to read the allowlist from (defaults to
 *   `process.env`; injectable for tests).
 * @returns `true` iff the allowlist contains `id` or the wildcard `'*'`.
 */
export function isProjectLocalToolTrusted(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const allow = parseAllowlist(env[PROJECT_TOOL_ALLOWLIST_ENV]);
  warnWildcardAllowlist(PROJECT_TOOL_ALLOWLIST_ENV, allow);
  return allow.has('*') || allow.has(id);
}

/**
 * Decide whether an installed npm tool with the given manifest `id` is trusted
 * to `import()` into the host process, under deny-by-default + allowlist-opt-in.
 *
 * Read timing and env governance mirror {@link isProjectLocalToolTrusted}: the
 * check runs at bootstrap before any `RunScope` exists, via the injected `env`
 * param for testability.
 *
 * @param id The tool's stable id (from `package.json#opensipTools.id`).
 * @param env The environment to read the allowlist from (defaults to
 *   `process.env`; injectable for tests).
 * @returns `true` iff the allowlist contains `id` or the wildcard `'*'`.
 */
export function isInstalledToolTrusted(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allow = parseAllowlist(env[INSTALLED_TOOL_ALLOWLIST_ENV]);
  warnWildcardAllowlist(INSTALLED_TOOL_ALLOWLIST_ENV, allow);
  return allow.has('*') || allow.has(id);
}

/**
 * Decide whether a third-party capability pack may be imported into the host
 * process. First-party bundled packs are handled by the caller; this predicate
 * is exact-name allowlist only and intentionally does not honor `*`.
 */
export function isCapabilityPackTrusted(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const allow = parseAllowlist(env[CAPABILITY_PACK_ALLOWLIST_ENV]);
  warnIgnoredCapabilityWildcard(allow);
  return allow.has(packageName);
}
