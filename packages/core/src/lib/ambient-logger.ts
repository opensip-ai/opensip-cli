/**
 * The run's logger, read through a narrow lens on the ambient store.
 *
 * Separate from `scope-storage-read.ts` for the same reason that file is separate from
 * `scope-storage.ts`: this one must stay a LEAF. `scope-storage-read` legitimately exposes the
 * full `RunScope` (that is its job), which makes it part of the registry → tools → baseline type
 * graph. The error kernel emits a migration warning and so needs a logger — and if it reached
 * one through a module that names `RunScope`, it would close a type cycle back onto itself.
 *
 * `logger.ts` imports only node builtins, so nothing here follows back into the error kernel.
 */

import { ambientStore } from './ambient-store.js';
import { logger as defaultLogger } from './logger.js';

import type { Logger } from './logger.js';

/**
 * The only part of the ambient scope this module needs. `RunScope` satisfies it structurally,
 * so this is a view of the same stored value — not a second store.
 */
interface AmbientLoggerCarrier {
  readonly logger?: Logger;
}

/** The run's logger, or the process default outside a run. */
export function currentLogger(): Logger {
  return ambientStore<AmbientLoggerCarrier>().getStore()?.logger ?? defaultLogger;
}
