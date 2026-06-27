import { logger } from '@opensip-cli/core';

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
 * runs; admit-with-allowlist when configured.** No interactive prompt UX
 * in this release. The allowlist is a comma/whitespace-separated list of
 * tool ids in the `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` environment variable
 * — a minimal, documented opt-in:
 *
 *   OPENSIP_CLI_ALLOW_PROJECT_TOOLS="my-audit, my-lint"   # admit by id
 *   OPENSIP_CLI_ALLOW_PROJECT_TOOLS="*"                    # admit all
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
