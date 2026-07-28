/**
 * The refusal used by the whole init authored-state transaction.
 *
 * Its own module because it is the plane's single failure identity and has no filesystem
 * dependencies — keeping it beside the fs helpers pushed that file past the length bound and
 * buried a contract behind a pile of directory walking.
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

const TRANSACTION_UNSAFE = hostErrorCatalog.require('CLI.INIT.AUTHORED_TRANSACTION_UNSAFE');

/**
 * Exported so consumers branch on the same identity this module throws with, rather than on a
 * second copy of the literal that can drift out of sync with it.
 */
export const AUTHORED_TRANSACTION_CODE = TRANSACTION_UNSAFE.code;

/**
 * The single refusal point for the init authored-state transaction (~199 call sites).
 *
 * Each caller's message names the exact invariant that broke. Those messages were being
 * discarded: the code had no catalog entry, so it resolved to `SYSTEM_ERROR` with
 * `exposure: 'redacted'` and the user was told "The operation failed." about a command that
 * had stopped partway through writing their project.
 *
 * `condition` is optional and last, for callers whose consumers branch; the message already
 * carries the detail for the rest.
 */
export function authoredTransactionFailure(
  message: string,
  cause?: unknown,
  condition?: string,
): never {
  throw new SystemError(`Init authored transaction failed: ${message}`, {
    code: TRANSACTION_UNSAFE.code,
    definition: TRANSACTION_UNSAFE,
    ...(cause === undefined ? {} : { cause }),
    ...(condition === undefined ? {} : { metadata: { condition } }),
  });
}
