import { currentScope } from '@opensip-cli/core';

import { loadCliDefaults } from './cli-defaults.js';

/** MUST match cliConfigSchema.sessions defaults in @opensip-cli/config. */
export const DEFAULT_SESSION_RETENTION_KEEP = 200;
export const DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS = 60;
export const DEFAULT_SESSION_RETENTION_MAX_SIZE_MB = 150;

export interface SessionRetentionPolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly maxSizeMb: number;
}

export type SessionRetentionPolicySource = 'scope' | 'cwd-fallback';

export interface ResolvedSessionRetentionPolicy extends SessionRetentionPolicy {
  readonly source: SessionRetentionPolicySource;
}

/** Normalize optional configuration against the host-owned retention defaults. */
export function resolveSessionRetentionPolicy(
  configured?: Partial<SessionRetentionPolicy>,
): SessionRetentionPolicy {
  return {
    keep: normalizedNonNegativeInt(configured?.keep, DEFAULT_SESSION_RETENTION_KEEP),
    maxAgeDays: normalizedNonNegativeInt(
      configured?.maxAgeDays,
      DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
    ),
    maxSizeMb: normalizedNonNegativeInt(
      configured?.maxSizeMb,
      DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    ),
  };
}

/** Resolve the effective retention policy from the entered project scope or cwd. */
export function resolveCurrentSessionRetentionPolicy(): ResolvedSessionRetentionPolicy {
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  const source: SessionRetentionPolicySource = projectRoot === undefined ? 'cwd-fallback' : 'scope';
  return {
    source,
    ...resolveSessionRetentionPolicy(loadCliDefaults(projectRoot ?? process.cwd()).sessions),
  };
}

function normalizedNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}
