import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  orgPolicyCacheSchema,
  readGlobalTrustPolicy,
  readProjectTrustPolicy,
  resolveTrustPolicySources,
  trustPolicySchema,
  type OrgPolicyStatus,
  type ResolvedTrustPolicy,
  type TrustPolicyDocument,
  type TrustPolicySource,
} from '@opensip-cli/config';
import { isPathInside, isPlainRecord, logger } from '@opensip-cli/core';

export const ORG_POLICY_CACHE_MAX_BYTES = 128 * 1024;

const POLICY_SOURCE_MODULE = 'cli:policy-source';
const ORG_CACHE_INVALID_EVENT = 'policy.org.cache.invalid';

export interface LoadedPolicySources {
  readonly policy: ResolvedTrustPolicy;
  readonly sources: readonly TrustPolicySource[];
  readonly diagnostics: readonly string[];
}

export interface LoadPreScopePolicySourcesInput {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly projectConfigPath?: string;
  readonly now: Date;
}

export function loadPreScopePolicySources(
  input: LoadPreScopePolicySourcesInput,
): LoadedPolicySources {
  const diagnostics: string[] = [];
  const sources: TrustPolicySource[] = [];

  const user = readGlobalTrustPolicy();
  if (user.policy !== undefined) sources.push({ tier: 'user', policy: user.policy });
  if (user.error !== undefined) {
    diagnostics.push(`user policy invalid: ${user.error}`);
    logger.warn({
      evt: 'policy.source.load.failed',
      module: POLICY_SOURCE_MODULE,
      sourceTier: 'user',
      reason: user.error,
    });
  }

  const projectPolicy = readProjectPolicy(input.projectConfigPath, diagnostics);
  if (projectPolicy !== undefined) sources.push({ tier: 'project', policy: projectPolicy });

  const base = resolveTrustPolicySources(sources, input.now);
  const hasOrgConfig = user.policy?.org !== undefined || projectPolicy?.org !== undefined;
  if (hasOrgConfig && input.projectRoot !== undefined) {
    const org = loadOrgPolicySource({
      projectRoot: input.projectRoot,
      policy: base,
      now: input.now,
    });
    diagnostics.push(...org.diagnostics);
    sources.push(org.source);
  }

  return { policy: resolveTrustPolicySources(sources, input.now), sources, diagnostics };
}

export function readValidatedProjectPolicy(document: unknown): TrustPolicyDocument | undefined {
  if (!isPlainRecord(document)) return undefined;
  const raw = document.policy;
  if (raw === undefined) return undefined;
  const parsed = trustPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function resolveRuntimePolicy(args: {
  readonly userPolicy?: TrustPolicyDocument;
  readonly projectPolicy?: TrustPolicyDocument;
  readonly projectRoot?: string;
  readonly now: Date;
}): LoadedPolicySources {
  const sources: TrustPolicySource[] = [];
  const diagnostics: string[] = [];
  if (args.userPolicy !== undefined) sources.push({ tier: 'user', policy: args.userPolicy });
  if (args.projectPolicy !== undefined)
    sources.push({ tier: 'project', policy: args.projectPolicy });
  const base = resolveTrustPolicySources(sources, args.now);
  if (
    (args.userPolicy?.org !== undefined || args.projectPolicy?.org !== undefined) &&
    args.projectRoot
  ) {
    const org = loadOrgPolicySource({ projectRoot: args.projectRoot, policy: base, now: args.now });
    diagnostics.push(...org.diagnostics);
    sources.push(org.source);
  }
  return { policy: resolveTrustPolicySources(sources, args.now), sources, diagnostics };
}

function readProjectPolicy(
  projectConfigPath: string | undefined,
  diagnostics: string[],
): TrustPolicyDocument | undefined {
  const result = readProjectTrustPolicy(projectConfigPath);
  if (result.policy !== undefined) return result.policy;
  if (result.error === undefined) return undefined;
  diagnostics.push(`project policy invalid: ${result.error}`);
  logger.warn({
    evt: 'policy.source.load.failed',
    module: POLICY_SOURCE_MODULE,
    sourceTier: 'project',
    reason: result.error,
  });
  return undefined;
}

function loadOrgPolicySource(args: {
  readonly projectRoot: string;
  readonly policy: ResolvedTrustPolicy;
  readonly now: Date;
}): { readonly source: TrustPolicySource; readonly diagnostics: readonly string[] } {
  const diagnostics: string[] = [];
  const cachePath = isAbsolute(args.policy.org.cachePath)
    ? args.policy.org.cachePath
    : resolve(args.projectRoot, args.policy.org.cachePath);
  const required = args.policy.org.required;
  const unavailable = (
    reason: string,
    evt: string,
  ): { source: TrustPolicySource; diagnostics: string[] } => {
    const orgStatus: OrgPolicyStatus = required
      ? { state: 'required-unavailable', reason }
      : { state: 'optional-unavailable', reason };
    diagnostics.push(`org policy ${reason}`);
    logger.warn({ evt, module: POLICY_SOURCE_MODULE, sourceTier: 'org', reason });
    return { source: { tier: 'org', orgStatus }, diagnostics };
  };

  if (!isStaticallyInside(cachePath, args.projectRoot)) {
    return unavailable('cache path escapes project root', ORG_CACHE_INVALID_EVENT);
  }
  if (!existsSync(cachePath)) {
    return unavailable('cache missing', 'policy.org.cache.missing');
  }
  if (!isPathInside(cachePath, args.projectRoot)) {
    return unavailable('cache realpath escapes project root', ORG_CACHE_INVALID_EVENT);
  }
  let stat;
  try {
    stat = statSync(cachePath);
  } catch {
    return unavailable('cache unreadable', ORG_CACHE_INVALID_EVENT);
  }
  if (stat.size > ORG_POLICY_CACHE_MAX_BYTES) {
    return unavailable('cache too large', ORG_CACHE_INVALID_EVENT);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
  } catch {
    return unavailable('cache invalid', ORG_CACHE_INVALID_EVENT);
  }
  const parsed = orgPolicyCacheSchema.safeParse(raw);
  if (!parsed.success) return unavailable('cache invalid', ORG_CACHE_INVALID_EVENT);
  const ageMs = args.now.getTime() - Date.parse(parsed.data.generatedAt);
  if (!Number.isFinite(ageMs) || ageMs > args.policy.org.maxAgeMs) {
    return unavailable('cache stale', 'policy.org.cache.stale');
  }
  return {
    source: {
      tier: 'org',
      policy: parsed.data.policy,
      orgStatus: { state: 'available', sourceTier: 'org' },
    },
    diagnostics,
  };
}

function isStaticallyInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
