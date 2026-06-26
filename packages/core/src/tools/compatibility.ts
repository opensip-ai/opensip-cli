/**
 * @fileoverview The single pure compatibility gate.
 *
 * One decision function the bundled and external admission paths share
 * (north-star §5.2): given the epoch a tool was compiled against
 * (`apiVersion`) and the supported plugin-API epoch range the engine
 * implements, return a `CompatibilityVerdict` — pure data.
 * The loader (Phase 2) and CLI (Phase 3) act on the verdict; this module
 * never logs, never exits, never touches the filesystem.
 *
 * Policy for the launch API:
 *   - `apiVersion` omitted ⇒ **incompatible**. A tool MUST declare the epoch
 *     it was compiled against; an unversioned plugin input is no longer admitted
 *     (north-star Principle 5 — version the inputs).
 *   - `MIN_SUPPORTED_PLUGIN_API_VERSION <= apiVersion <= PLUGIN_API_VERSION`
 *     ⇒ compatible.
 *   - otherwise ⇒ incompatible, carrying both integers + a human reason
 *     (future vs. past epoch).
 */

import { MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION } from './manifest.js';

const DEFAULT_PLUGIN_API_RANGE: PluginApiCompatibilityRange = {
  minSupported: MIN_SUPPORTED_PLUGIN_API_VERSION,
  current: PLUGIN_API_VERSION,
};

/** The supported plugin-API epoch range the engine implements. */
export interface PluginApiCompatibilityRange {
  readonly minSupported: number;
  readonly current: number;
}

/**
 * The outcome of the compatibility gate — pure data the caller acts on.
 *
 *   - `compatible`   — admit the tool.
 *   - `incompatible` — reject; carries the declared + engine epochs and a
 *                      human-readable reason for diagnostics / logs.
 */
export type CompatibilityVerdict =
  | { readonly kind: 'compatible' }
  | {
      readonly kind: 'incompatible';
      readonly declared: number;
      readonly minSupported: number;
      readonly engine: number;
      readonly reason: string;
    };

/**
 * Decide whether a tool declaring `apiVersion` is compatible with the
 * engine's supported plugin-API epoch range.
 *
 * @param apiVersion The epoch the tool was compiled against, or `undefined`
 *   (a missing epoch is incompatible).
 * @param range The supported epoch range. Defaults to
 *   `[MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION]`; overridable for
 *   tests / as-if-external probes.
 * @returns A `CompatibilityVerdict` — never throws.
 */
export function checkCompatibility(
  apiVersion: number | undefined,
  range: PluginApiCompatibilityRange = DEFAULT_PLUGIN_API_RANGE,
): CompatibilityVerdict {
  const { minSupported, current } = range;

  if (minSupported > current) {
    return {
      kind: 'incompatible',
      declared: apiVersion ?? Number.NaN,
      minSupported,
      engine: current,
      reason: `engine plugin API range is misconfigured (${minSupported}..${current}); minSupported must be <= current`,
    };
  }

  // A tool that declares no `apiVersion` is incompatible: unversioned plugin
  // input is not admitted off the marker alone.
  if (apiVersion === undefined) {
    return {
      kind: 'incompatible',
      declared: Number.NaN,
      minSupported,
      engine: current,
      reason: `tool declares no plugin apiVersion; declare \`apiVersion\` in the supported range ${minSupported}..${current}`,
    };
  }

  if (apiVersion >= minSupported && apiVersion <= current) {
    return { kind: 'compatible' };
  }

  const reason =
    apiVersion > current
      ? `tool targets plugin API v${apiVersion} but this engine supports v${minSupported}..v${current}; upgrade OpenSIP CLI to load it`
      : `tool targets plugin API v${apiVersion} which is below the supported range v${minSupported}..v${current}; upgrade the tool`;

  return {
    kind: 'incompatible',
    declared: apiVersion,
    minSupported,
    engine: current,
    reason,
  };
}
