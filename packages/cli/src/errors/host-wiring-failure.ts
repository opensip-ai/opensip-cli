/**
 * The failure funnel for "the host was misdriven" — `CLI.HOST.WIRING_INVALID`.
 *
 * WHY THIS IS A SEPARATE MODULE
 * The raisers are spread across command mounting, dispatch, and the view layer, and several of
 * them sit upstream of the modules that interpret the failure. Putting the funnel beside any one
 * of them would close an import cycle — which is exactly what happened twice during the
 * `commands/init` migration, the second time caught only by `depcruise no-circular`. This module
 * imports nothing but the kernel and the host catalog, so every raiser can depend on it.
 *
 * WHAT IT MEANS
 * A host code path ran in a state the composition root should have made impossible: a command
 * result shape the view layer cannot render, a `commandSpec` that declares an output the mount
 * context cannot provide, two tools claiming one scaffold identity. These are not user errors and
 * not environment errors — the operator's only action is to report them.
 *
 * The definition is `exposure: 'redacted'` ON PURPOSE, and that is not the defect Plan 01 removes.
 * These messages embed internal wiring detail and, in the exhaustiveness guards, a
 * `JSON.stringify` of an arbitrary command result — which can carry paths or payload data. The
 * public projection therefore withholds the message and shows the operator action ("capture the
 * run id and report a bug"), while the code, the `condition`, and the operator projection keep the
 * full diagnosis for whoever reads the logs. Registering these buys machine identity and a
 * correct exit class, not a louder message.
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from './host-error-catalog.js';

const WIRING_INVALID = hostErrorCatalog.require('CLI.HOST.WIRING_INVALID');

/**
 * Raise the registered host-wiring invariant failure.
 *
 * `condition` is required, not optional: it is the only part of this failure that survives the
 * redacted projection, so a site that omitted it would be indistinguishable from every other
 * wiring fault in the logs. Making it a required parameter lets the compiler prove no call site
 * forgets (ruling D9).
 *
 * @throws {SystemError} always — the host was driven into an impossible state.
 */
export function hostWiringInvalid(message: string, condition: string, cause?: unknown): never {
  throw new SystemError(message, {
    code: WIRING_INVALID.code,
    definition: WIRING_INVALID,
    metadata: { condition },
    diagnostic: condition,
    ...(cause === undefined ? {} : { cause }),
  });
}
