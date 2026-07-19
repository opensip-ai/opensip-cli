/**
 * User-level capability-pack trust ceremony used by the policy host commands.
 *
 * Kept separate from declarative command assembly so provenance resolution,
 * audit recording, and global trust mutation remain one reviewable boundary.
 */

import { grantCapabilityTrust, revokeCapabilityTrust } from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  readDeclaredCapabilityPackageMetadata,
  resolvePackageDir,
} from '@opensip-cli/core';

import { policyAuditFromCurrentScope } from '../bootstrap/policy-pep.js';

import type { CliCommandsContext } from './shared.js';
import type { ErrorResult, PolicyTrustResult } from '@opensip-cli/contracts';

/** Exact npm package name (optionally scoped) — rejects path traversal input. */
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

function policyTrustError(message: string): ErrorResult {
  return { type: 'error', message, exitCode: EXIT_CODES.CONFIGURATION_ERROR };
}

function recordTrustCeremony(input: {
  readonly action: 'trust' | 'untrust';
  readonly id: string;
  readonly outcome: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly manifestHash?: string;
}): void {
  policyAuditFromCurrentScope()?.record({
    occurredAt: new Date().toISOString(),
    action: input.action,
    subject: `capability-pack:${input.id}`,
    outcome: input.outcome,
    sourceTier: 'user',
    reasons: input.reasons,
    exceptionIds: [],
    metadata: input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash },
  });
  currentLogger().info({
    evt: `policy.command.${input.action}.complete`,
    module: 'cli:policy-command',
    packageName: input.id,
    outcome: input.outcome,
  });
}

/**
 * Grant trust bound to the currently resolved capability manifest.
 *
 * @returns A command result; invalid or unresolved packages are represented as
 *   configuration errors rather than thrown exceptions.
 */
export function executePolicyTrust(
  packageName: string,
  ctx: CliCommandsContext,
): PolicyTrustResult | ErrorResult {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError(`Invalid package name '${packageName}'.`);
  }
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  if (projectRoot === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError('policy trust must run inside a project (no project root resolved).');
  }
  const packageDir = resolvePackageDir(projectRoot, packageName);
  if (packageDir === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    recordTrustCeremony({
      action: 'trust',
      id: packageName,
      outcome: 'deny',
      reasons: ['package not resolvable from the project'],
    });
    return policyTrustError(
      `Package '${packageName}' is not resolvable from ${projectRoot} — install it first.`,
    );
  }
  const metadata = readDeclaredCapabilityPackageMetadata(packageDir);
  if (metadata?.manifestHash === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    recordTrustCeremony({
      action: 'trust',
      id: packageName,
      outcome: 'deny',
      reasons: ['package declares no opensipTools capability manifest'],
    });
    return policyTrustError(
      `Package '${packageName}' declares no opensipTools capability manifest — nothing to trust.`,
    );
  }
  grantCapabilityTrust({
    id: packageName,
    manifestHash: metadata.manifestHash,
    grantedAt: new Date().toISOString(),
  });
  recordTrustCeremony({
    action: 'trust',
    id: packageName,
    outcome: 'allow',
    reasons: ['operator granted capability trust'],
    manifestHash: metadata.manifestHash,
  });
  return {
    type: 'policy-trust',
    id: packageName,
    action: 'granted',
    manifestHash: metadata.manifestHash,
  };
}

/** Revoke an existing user-level capability-pack trust grant. */
export function executePolicyUntrust(
  packageName: string,
  ctx: CliCommandsContext,
): PolicyTrustResult | ErrorResult {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError(`Invalid package name '${packageName}'.`);
  }
  const removed = revokeCapabilityTrust(packageName);
  recordTrustCeremony({
    action: 'untrust',
    id: packageName,
    outcome: 'allow',
    reasons: [removed ? 'operator revoked capability trust' : 'no grant existed'],
  });
  return { type: 'policy-trust', id: packageName, action: removed ? 'revoked' : 'not-found' };
}
