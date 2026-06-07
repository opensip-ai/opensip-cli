/**
 * @fileoverview The single pure compatibility gate (release 2.8.0).
 *
 * One decision function the bundled and external admission paths share
 * (north-star §5.2): given the epoch a tool was compiled against
 * (`apiVersion`) and the epoch the engine implements
 * (`PLUGIN_API_VERSION`), return a `CompatibilityVerdict` — pure data.
 * The loader (Phase 2) and CLI (Phase 3) act on the verdict; this module
 * never logs, never exits, never touches the filesystem.
 *
 * Policy:
 *   - `apiVersion` omitted ⇒ **compatible** (the grace window — a tool
 *     that predates the epoch is admitted as if current).
 *   - `apiVersion === engine` ⇒ compatible.
 *   - otherwise ⇒ incompatible, carrying both integers + a human reason
 *     (future vs. past epoch).
 */

import { PLUGIN_API_VERSION } from './manifest.js';

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
      readonly engine: number;
      readonly reason: string;
    };

/**
 * Decide whether a tool declaring `apiVersion` is compatible with the
 * engine epoch.
 *
 * @param apiVersion The epoch the tool was compiled against, or
 *   `undefined` (grace window — treated as compatible).
 * @param engine The epoch the running engine implements. Defaults to
 *   `PLUGIN_API_VERSION`; overridable for tests / as-if-external probes.
 * @returns A `CompatibilityVerdict` — never throws.
 */
export function checkCompatibility(
  apiVersion: number | undefined,
  engine: number = PLUGIN_API_VERSION,
): CompatibilityVerdict {
  // Grace window: a tool that predates the epoch (no declared apiVersion)
  // is admitted as if it targets the current engine.
  if (apiVersion === undefined) {
    return { kind: 'compatible' };
  }

  if (apiVersion === engine) {
    return { kind: 'compatible' };
  }

  const reason =
    apiVersion > engine
      ? `tool targets plugin API v${apiVersion} but this engine implements v${engine}; upgrade opensip-tools to load it`
      : `tool targets plugin API v${apiVersion} which this engine (v${engine}) no longer supports; upgrade the tool`;

  return { kind: 'incompatible', declared: apiVersion, engine, reason };
}
