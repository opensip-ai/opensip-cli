/**
 * Shared axis bases for the host catalog's definition modules.
 *
 * Extracted so each module can share them without a cycle through the assembling catalog —
 * the same shape `@opensip-cli/core` uses for its own split catalog.
 */

import type { ErrorDefinition } from '@opensip-cli/core';

export const USER_INPUT = {
  source: 'application',
  defaultResponsibility: 'user',
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'configuration',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

/**
 * The host failed to wire itself. Nobody outside this repository can act on these, so they are
 * `redacted` and say "report a bug" honestly rather than inventing a step the operator does
 * not have.
 */
export const HOST_WIRING = {
  source: 'application',
  defaultResponsibility: 'tool-author',
  kind: 'invariant',
  retry: 'never',
  severity: 'error',
  exposure: 'redacted',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;
