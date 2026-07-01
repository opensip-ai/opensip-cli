/**
 * @fileoverview The `@opensip-cli/core` scope ABI — the compatibility contract
 * for the per-run `RunScope` value that flows through the `globalThis`-pinned
 * `AsyncLocalStorage` (see run-scope.ts) and is read by capability packs during
 * check/scenario/rule execution.
 *
 * This is the identity the single-core guard (single-core-guard.ts) keys on when
 * deciding whether a discovered pack's resolved core is "the same core" as the
 * running engine — NOT the npm package version (ADR-0103). Two cores that share
 * a scope ABI interoperate regardless of their npm versions.
 *
 * SOURCE OF TRUTH: `SCOPE_ABI_VERSION` here is mirrored by
 * `opensipScopeAbiVersion` in `packages/core/package.json` so the guard can read
 * a FOREIGN core's ABI from its manifest without importing it. A test asserts the
 * two never drift.
 *
 * BUMP RULES: increment `SCOPE_ABI_VERSION` (and the package.json field) ONLY on
 * a breaking change to the RunScope read-surface — a field that pack execution
 * reads being removed/renamed, or the ALS pin key changing. Additive-only changes
 * (new optional fields older code ignores) do NOT bump it.
 */

/** The scope ABI epoch this core implements. See file header for bump rules. */
export const SCOPE_ABI_VERSION = 1;

/** The package.json manifest field that mirrors {@link SCOPE_ABI_VERSION}. */
export const SCOPE_ABI_MANIFEST_FIELD = 'opensipScopeAbiVersion';

/**
 * The earliest `@opensip-cli/core` release that implements scope ABI 1: v0.1.11
 * (`41d4531b`), which introduced the `globalThis`-pinned scope
 * `AsyncLocalStorage`. Every core at or above this floor shares one scope store
 * and the same RunScope read-surface, so an ABI-1 core that predates the
 * `opensipScopeAbiVersion` manifest field can be inferred as ABI 1 from its
 * version alone. Cores below the floor lack the shared-ALS pin and are foreign
 * (a genuine split-scope hazard), so the guard falls back to exact-version
 * identity for them. Verify with `git tag --contains 41d4531b`.
 */
export const SCOPE_ABI_MIN_CORE_VERSION = '0.1.11';

/** Parsed `major.minor.patch` triple; prerelease/build metadata is ignored. */
interface SemverTriple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse `major.minor.patch` from a version string, or undefined if unparseable. */
function parseSemver(version: string): SemverTriple | undefined {
  const core = version.trim().split('+')[0]?.split('-')[0] ?? '';
  const parts = core.split('.');
  if (parts.length < 3) return undefined;
  const [major, minor, patch] = parts.map((p) => Number.parseInt(p, 10));
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    Number.isNaN(patch)
  ) {
    return undefined;
  }
  return { major, minor, patch };
}

/**
 * Whether `version` is >= {@link SCOPE_ABI_MIN_CORE_VERSION} — i.e. new enough to
 * be inferred as scope ABI 1 when it carries no `opensipScopeAbiVersion` field.
 * An unparseable version is treated as below the floor (conservative).
 */
export function coreVersionImplementsScopeAbi1(version: string): boolean {
  const v = parseSemver(version);
  const floor = parseSemver(SCOPE_ABI_MIN_CORE_VERSION);
  if (v === undefined || floor === undefined) return false;
  if (v.major !== floor.major) return v.major > floor.major;
  if (v.minor !== floor.minor) return v.minor > floor.minor;
  return v.patch >= floor.patch;
}
