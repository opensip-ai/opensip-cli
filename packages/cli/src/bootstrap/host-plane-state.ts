/**
 * host-plane-state — reserved tool_state identity for host governance/audit/
 * entitlement blobs (ADR-0146).
 *
 * Host planes store opaque JSON under the reserved identity
 * `@opensip-cli/host-plane:<toolId>` so tool-owned `governance` / `audit` /
 * `entitlements` keys cannot collide with host compatibility data.
 *
 * One pure predicate recognizes the reserved prefix. Runtime Tool admission
 * (`validate-tool`) and binder-owned-key validation (`tool-owned-keys`) both
 * consume it; helpers and purge re-check as defense in depth.
 */

import { ConfigurationError, PluginIncompatibleError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

const OPTION_INVALID = hostErrorCatalog.require('CLI.HOST.OPTION_INVALID');
const HOST_IDENTITY_RESERVED = hostErrorCatalog.require('CLI.HOST_IDENTITY.RESERVED');

/** Exact reserved prefix for host-plane storage identities. */
export const HOST_PLANE_STATE_PREFIX = '@opensip-cli/host-plane:' as const;

/**
 * True when `value` begins with the reserved host-plane identity prefix.
 * Empty / non-string values are not reserved.
 */
export function isReservedHostPlaneIdentity(value: string): boolean {
  return value.startsWith(HOST_PLANE_STATE_PREFIX);
}

/**
 * Map a bound tool id to its reserved host-plane storage identity.
 *
 * @throws {ConfigurationError} when `toolId` is empty/whitespace
 * @throws {PluginIncompatibleError} when `toolId` already carries the reserved prefix
 */
export function hostPlaneStateIdentity(toolId: string): string {
  const trimmed = toolId.trim();
  if (trimmed.length === 0) {
    throw new ConfigurationError('hostPlaneStateIdentity: toolId must be non-empty', {
      code: OPTION_INVALID.code,
      definition: OPTION_INVALID,
      metadata: { condition: 'empty-tool-id', field: 'toolId' },
    });
  }
  if (isReservedHostPlaneIdentity(trimmed)) {
    throw new PluginIncompatibleError(
      `hostPlaneStateIdentity: toolId already carries the reserved prefix (${HOST_PLANE_STATE_PREFIX})`,
      {
        code: HOST_IDENTITY_RESERVED.code,
        definition: HOST_IDENTITY_RESERVED,
        metadata: { condition: 'reserved-prefix', value: trimmed },
        diagnostic: 'toolId already carries host-plane prefix',
      },
    );
  }
  return `${HOST_PLANE_STATE_PREFIX}${trimmed}`;
}
