/**
 * The failure funnel for a refused `plugins.<domain>` config edit — `CLI.PLUGIN.EDIT_REFUSED`.
 *
 * A leaf module by design: it imports only the kernel and the host catalog, so the command that
 * raises the failure never gains an edge on the module that classifies it. Putting a funnel beside
 * the policy that interprets it closed two import cycles earlier in this plan.
 *
 * These are the most actionable messages in the plugin surface — each names the file, the exact
 * region, and the fix. As bare `Error`s every one of them normalized to `SYSTEM_ERROR` (exposure
 * `redacted`), so an operator whose config had a YAML typo was told "The operation failed."
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from './host-error-catalog.js';

const PLUGIN_EDIT_REFUSED = hostErrorCatalog.require('CLI.PLUGIN.EDIT_REFUSED');

/**
 * The way the config file defeated the edit (D9).
 *
 * A closed union: these are the four structural preconditions the editor checks, and a new one
 * should be a deliberate addition rather than a typo in a string literal.
 */
export type PluginEditCondition =
  'yaml-syntax-invalid' | 'root-not-mapping' | 'plugins-not-mapping' | 'domain-not-sequence';

/** @throws {SystemError} always — the config file is not editable as requested. */
export function pluginEditRefused(
  message: string,
  condition: PluginEditCondition,
  path: string,
  domain: string,
): never {
  throw new SystemError(message, {
    code: PLUGIN_EDIT_REFUSED.code,
    definition: PLUGIN_EDIT_REFUSED,
    metadata: { condition, path, domain },
    diagnostic: condition,
  });
}
