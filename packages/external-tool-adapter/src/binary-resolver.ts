/**
 * @fileoverview Layered, deterministic binary resolution (ADR-0090 §4.3).
 *
 * First hit wins: an operator pin (the `OPENSIP_<TOOL>_BIN` env var, then the
 * `binaries.<tool>.path` config) always beats the system `PATH`. A pin that is
 * non-absolute or missing is a HARD miss — the substrate does NOT silently fall
 * back to `PATH` (the operator asked for a specific binary). A `PATH` miss yields
 * a not-found result (the caller raises a `ConfigurationError` pointing at
 * `doctor`); resolution NEVER fetches a binary.
 *
 * Pure given its {@link BinaryResolveDeps} (existence check + PATH lookup) — the
 * real deps live in `process-exec.ts` (the IO boundary). Returns data, never
 * throws.
 */

import { isAbsolute } from 'node:path';

import type { BinaryResolutionLayer } from './types.js';

/** The IO deps `resolveBinary` is parameterized over (real impls in `process-exec.ts`). */
export interface BinaryResolveDeps {
  readonly existsSync: (path: string) => boolean;
  readonly which: (command: string, platform: NodeJS.Platform) => string | undefined;
}

export interface ResolveBinaryInput {
  /** The PATH lookup name (`'gitleaks'`). */
  readonly command: string;
  /** An operator-pinned absolute path from the namespaced config (`binaries.<tool>.path`). */
  readonly configuredPath?: string;
  /** An operator-pinned absolute path from `OPENSIP_<TOOL>_BIN`. */
  readonly envPath?: string;
  /** The host platform (defaults to `process.platform`). */
  readonly platform?: NodeJS.Platform;
}

/** The outcome of {@link resolveBinary}. */
export type BinaryResolution =
  | { readonly found: true; readonly path: string; readonly layer: BinaryResolutionLayer }
  | {
      readonly found: false;
      readonly command: string;
      readonly reason: string;
      readonly searched: readonly string[];
    };

/** Validate one operator-pinned path (absolute + exists). Returns the resolution or a miss reason. */
function resolvePin(
  path: string,
  layer: 'config' | 'env',
  deps: BinaryResolveDeps,
): BinaryResolution {
  if (!isAbsolute(path)) {
    return {
      found: false,
      command: path,
      reason: `${layer} binary path must be absolute: ${path}`,
      searched: [path],
    };
  }
  if (!deps.existsSync(path)) {
    return {
      found: false,
      command: path,
      reason: `${layer} binary path does not exist: ${path}`,
      searched: [path],
    };
  }
  return { found: true, path, layer };
}

/**
 * Resolve the scanner binary by the layered order env-pin → config-pin → `PATH`.
 * An operator pin (env or config) wins and never falls through to `PATH`; a
 * broken pin is a hard miss with a reason.
 */
export function resolveBinary(
  input: ResolveBinaryInput,
  deps: BinaryResolveDeps,
): BinaryResolution {
  const envPath = input.envPath?.trim();
  if (envPath !== undefined && envPath.length > 0) {
    return resolvePin(envPath, 'env', deps);
  }

  const configuredPath = input.configuredPath?.trim();
  if (configuredPath !== undefined && configuredPath.length > 0) {
    return resolvePin(configuredPath, 'config', deps);
  }

  const platform = input.platform ?? process.platform;
  const onPath = deps.which(input.command, platform);
  if (onPath !== undefined && onPath.length > 0) {
    return { found: true, path: onPath, layer: 'path' };
  }
  return {
    found: false,
    command: input.command,
    reason: `'${input.command}' was not found on PATH`,
    searched: [`PATH:${input.command}`],
  };
}

/** Derive the default env-var name that pins a tool's binary: `OPENSIP_<TOOL>_BIN`. */
export function defaultBinaryEnvVar(tool: string): string {
  return `OPENSIP_${tool.replaceAll('-', '_').toUpperCase()}_BIN`;
}
