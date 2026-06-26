/**
 * createToolLogger — stamps a fixed `module` field on every structured log entry
 * while delegating to the scope-backed run logger (Plan 06 / ADR-0077).
 */

import { currentLogger } from './run-scope.js';

import type { Logger } from './logger.js';

function mergeEntry(
  module: string,
  msgOrObj: string | Record<string, unknown>,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof msgOrObj === 'string') {
    return { module, msg: msgOrObj, ...data };
  }
  const rest = { ...msgOrObj };
  delete rest.module;
  return { module, ...rest, ...data };
}

/**
 * Returns a {@link Logger} that stamps `module` on every entry. Reads the current
 * run scope logger via {@link currentLogger} unless a `base` logger is supplied.
 */
export function createToolLogger(module: string, base?: Logger): Logger {
  const delegate = base ?? currentLogger();
  return {
    debug: (msgOrObj, data) => delegate.debug(mergeEntry(module, msgOrObj, data)),
    info: (msgOrObj, data) => delegate.info(mergeEntry(module, msgOrObj, data)),
    warn: (msgOrObj, data) => delegate.warn(mergeEntry(module, msgOrObj, data)),
    error: (msgOrObj, data) => delegate.error(mergeEntry(module, msgOrObj, data)),
  };
}
