/**
 * @fileoverview Validate + carry through a capability domain's optional
 * `discovery` descriptor (§5.3) when the manifest loader normalizes a tool's
 * `capabilities[]`. The descriptor is the datum the generic discovery substrate
 * reads, so it must survive the loader's strip-unknown-fields normalization.
 */

import { isRecord, isStringArray } from './json-guards.js';

import type {
  CapabilityCoContribution,
  CapabilityDiscoveryDescriptor,
  CapabilityDiscoveryMode,
} from '../tools/capability.js';

/**
 * Tri-state result of parsing a capability's optional `discovery` field:
 * - `absent` — the field is missing (the domain auto-discovers nothing).
 * - `invalid` — the field is present but malformed (fails the whole manifest,
 *   mirroring the strict `contributionKind` check).
 * - `ok` — a validated descriptor to carry onto the normalized capability.
 *
 * Modeled as a single discriminated union (not `T | 'invalid' | undefined`) so
 * callers branch on `.status` and every code path returns one type.
 */
export type DiscoveryParse =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly descriptor: CapabilityDiscoveryDescriptor };

/** Parse + validate a capability's `discovery` field into a {@link DiscoveryParse}. */
export function normalizeDiscovery(value: unknown): DiscoveryParse {
  if (value === undefined) return { status: 'absent' };
  if (!isRecord(value)) return { status: 'invalid' };
  const mode = normalizeDiscoveryMode(value.discovery);
  if (mode === undefined) return { status: 'invalid' };
  if (typeof value.exportName !== 'string' || value.exportName === '') return { status: 'invalid' };
  if (value.exportShape !== 'array' && value.exportShape !== 'single') return { status: 'invalid' };
  const configKeys = normalizeConfigKeys(value.configKeys);
  if (configKeys === undefined) return { status: 'invalid' };
  if (value.builtinScope !== undefined && typeof value.builtinScope !== 'string') return { status: 'invalid' };
  if (value.explicitListMode !== undefined && value.explicitListMode !== 'replace' && value.explicitListMode !== 'augment') {
    return { status: 'invalid' };
  }
  const co = normalizeCoContributions(value.coContributions);
  if (co.status === 'invalid') return { status: 'invalid' };
  return {
    status: 'ok',
    descriptor: {
      discovery: mode,
      exportName: value.exportName,
      exportShape: value.exportShape,
      configKeys,
      ...(value.builtinScope === undefined ? {} : { builtinScope: value.builtinScope }),
      ...(value.explicitListMode === undefined ? {} : { explicitListMode: value.explicitListMode }),
      ...(co.status === 'ok' ? { coContributions: co.value } : {}),
    },
  };
}

/** Tri-state parse of the optional `coContributions` field (absent | invalid | ok). */
type CoContributionsParse =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly value: readonly CapabilityCoContribution[] };

/** Validate the optional `coContributions` array (each: exportName + exportShape + domainId). */
function normalizeCoContributions(value: unknown): CoContributionsParse {
  if (value === undefined) return { status: 'absent' };
  if (!Array.isArray(value)) return { status: 'invalid' };
  const out: CapabilityCoContribution[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return { status: 'invalid' };
    if (typeof entry.exportName !== 'string' || entry.exportName === '') return { status: 'invalid' };
    if (entry.exportShape !== 'array' && entry.exportShape !== 'single') return { status: 'invalid' };
    if (typeof entry.domainId !== 'string' || entry.domainId === '') return { status: 'invalid' };
    out.push({ exportName: entry.exportName, exportShape: entry.exportShape, domainId: entry.domainId });
  }
  return { status: 'ok', value: out };
}

/** Validate the optional, all-string `configKeys` map. Returns `undefined` on any non-string member. */
function normalizeConfigKeys(value: unknown): CapabilityDiscoveryDescriptor['configKeys'] | undefined {
  if (!isRecord(value)) return undefined;
  for (const k of ['packages', 'autoDiscover', 'scopes'] as const) {
    if (value[k] !== undefined && typeof value[k] !== 'string') return undefined;
  }
  return {
    ...(value.packages === undefined ? {} : { packages: value.packages as string }),
    ...(value.autoDiscover === undefined ? {} : { autoDiscover: value.autoDiscover as string }),
    ...(value.scopes === undefined ? {} : { scopes: value.scopes as string }),
  };
}

/** Validate the discriminated discovery mode (marker | name-pattern). */
function normalizeDiscoveryMode(value: unknown): CapabilityDiscoveryMode | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === 'marker') {
    return typeof value.markerKind === 'string' && value.markerKind !== ''
      ? { mode: 'marker', markerKind: value.markerKind }
      : undefined;
  }
  if (value.mode === 'name-pattern') {
    if (typeof value.prefix !== 'string' || value.prefix === '') return undefined;
    if (!isStringArray(value.defaultScopes)) return undefined;
    return { mode: 'name-pattern', prefix: value.prefix, defaultScopes: value.defaultScopes };
  }
  return undefined;
}
