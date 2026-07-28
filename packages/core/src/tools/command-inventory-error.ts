/**
 * Failure funnel for runtime command inventory admission.
 *
 * Leaf module: imports only catalog + ValidationError so validators and freeze
 * helpers can share codes without import cycles (same shape as host init funnels).
 */

import { coreErrorCatalog } from '../lib/errors/core-error-catalog.js';
import { ValidationError } from '../lib/errors.js';

const INVALID = coreErrorCatalog.require('CORE.COMMAND_INVENTORY.INVALID');
const DUPLICATE = coreErrorCatalog.require('CORE.COMMAND_INVENTORY.DUPLICATE_PATH');
const HANDLER = coreErrorCatalog.require('CORE.COMMAND_INVENTORY.HANDLER_CLAIM_INVALID');
const LIMIT = coreErrorCatalog.require('CORE.COMMAND_INVENTORY.LIMIT_EXCEEDED');
const PACKAGE_IDENTITY = coreErrorCatalog.require(
  'CORE.COMMAND_INVENTORY.PACKAGE_IDENTITY_INVALID',
);

/** Closed inventory-shape branches (required so call sites name a projectable condition). */
export type CommandInventoryInvalidCondition =
  | 'reason-string'
  | 'leaf-path'
  | 'leaf-name'
  | 'leaf-owner'
  | 'leaf-owner-label'
  | 'leaf-visibility'
  | 'leaf-scope'
  | 'leaf-output'
  | 'leaf-alias'
  | 'leaf-aliases-shape'
  | 'group-path'
  | 'group-name'
  | 'group-owner'
  | 'group-owner-label'
  | 'group-visibility';

export type CommandInventoryLimitCondition = 'max-leaves' | 'max-groups' | 'max-aliases';

export type CommandInventoryHandlerCondition =
  'package-identity' | 'static-handler-path' | 'static-handler-declaration';

export type CommandInventoryDuplicateCondition = 'leaf-path' | 'group-path';

/** Shape/field refusal for a leaf or group. */
export function commandInventoryInvalid(
  condition: CommandInventoryInvalidCondition,
  message: string,
  field?: string,
): ValidationError {
  return new ValidationError(message, {
    code: INVALID.code,
    definition: INVALID,
    metadata: {
      condition,
      ...(field === undefined ? {} : { field }),
    },
  });
}

/** Two leaves/groups claim the same path. */
export function commandInventoryDuplicate(
  condition: CommandInventoryDuplicateCondition,
  message: string,
  value: string,
): ValidationError {
  return new ValidationError(message, {
    code: DUPLICATE.code,
    definition: DUPLICATE,
    metadata: { condition, field: 'path', value },
  });
}

/** Static-handler / package-identity claim refusal. */
export function commandInventoryHandlerClaim(
  condition: CommandInventoryHandlerCondition,
  message: string,
): ValidationError {
  const def = condition === 'package-identity' ? PACKAGE_IDENTITY : HANDLER;
  return new ValidationError(message, {
    code: def.code,
    definition: def,
    metadata: { condition, field: condition },
  });
}

/** Inventory exceeds a declared anti-DoS bound. */
export function commandInventoryLimitExceeded(
  condition: CommandInventoryLimitCondition,
  message: string,
  bound: number,
): ValidationError {
  return new ValidationError(message, {
    code: LIMIT.code,
    definition: LIMIT,
    metadata: { condition, bound },
  });
}
