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
 * Policy (3.0.0 GA — the grace window ended):
 *   - `apiVersion` omitted ⇒ **incompatible**. A tool MUST declare the epoch
 *     it was compiled against; an unversioned plugin input is no longer admitted
 *     (north-star Principle 5 — version the inputs).
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
 * @param apiVersion The epoch the tool was compiled against, or `undefined`
 *   (3.0.0 — a missing epoch is now INCOMPATIBLE; the grace window ended).
 * @param engine The epoch the running engine implements. Defaults to
 *   `PLUGIN_API_VERSION`; overridable for tests / as-if-external probes.
 * @returns A `CompatibilityVerdict` — never throws.
 */
export function checkCompatibility(
  apiVersion: number | undefined,
  engine: number = PLUGIN_API_VERSION,
): CompatibilityVerdict {
  // 3.0.0 GA: a tool that declares no `apiVersion` is incompatible — an
  // unversioned plugin input is no longer admitted off the marker alone.
  if (apiVersion === undefined) {
    return {
      kind: 'incompatible',
      declared: Number.NaN,
      engine,
      reason: `tool declares no plugin apiVersion; declare \`apiVersion: ${engine}\` in its manifest (the grace window ended at 3.0.0)`,
    };
  }

  if (apiVersion === engine) {
    return { kind: 'compatible' };
  }

  const reason =
    apiVersion > engine
      ? `tool targets plugin API v${apiVersion} but this engine implements v${engine}; upgrade OpenSIP CLI to load it`
      : `tool targets plugin API v${apiVersion} which this engine (v${engine}) no longer supports; upgrade the tool`;

  return { kind: 'incompatible', declared: apiVersion, engine, reason };
}
