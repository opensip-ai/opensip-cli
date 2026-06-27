/**
 * @fileoverview Pure capability contribution epoch compatibility gate.
 *
 * Validates that a package-discovered contribution's declared target domain
 * and target domain API epoch fall within the owning domain's supported range
 * before the loader routes the contribution to a registrar.
 */

import type { CapabilityDomainSpec } from '../tools/capability.js';

/** Compatibility decision for a package contribution against the selected capability domain. */
export type CapabilityCompatibilityVerdict =
  | { readonly kind: 'compatible' }
  | {
      readonly kind: 'incompatible';
      readonly reason: string;
      readonly declaredTargetDomain?: string;
      readonly declaredApiVersion?: number;
      readonly minSupportedApiVersion: number;
      readonly currentApiVersion: number;
    };

/** Inputs for checking package-declared target-domain metadata against a domain spec. */
export interface CheckCapabilityContributionCompatibilityArgs {
  readonly targetDomainId: string;
  readonly packageTargetDomain?: string;
  readonly packageTargetDomainApiVersion?: number;
  readonly domainSpec: CapabilityDomainSpec;
}

/**
 * Decide whether a package-discovered contribution targets a compatible
 * domain API epoch for the registered domain spec.
 */
export function checkCapabilityContributionCompatibility(
  args: CheckCapabilityContributionCompatibilityArgs,
): CapabilityCompatibilityVerdict {
  const { targetDomainId, packageTargetDomain, packageTargetDomainApiVersion, domainSpec } = args;
  const { minSupportedApiVersion, apiVersion: currentApiVersion } = domainSpec;

  if (packageTargetDomain === undefined) {
    return {
      kind: 'incompatible',
      reason: `capability package is missing opensipTools.targetDomain`,
      minSupportedApiVersion,
      currentApiVersion,
    };
  }

  if (packageTargetDomainApiVersion === undefined) {
    return {
      kind: 'incompatible',
      reason: `capability package is missing opensipTools.targetDomainApiVersion`,
      declaredTargetDomain: packageTargetDomain,
      minSupportedApiVersion,
      currentApiVersion,
    };
  }

  if (packageTargetDomain !== targetDomainId) {
    return {
      kind: 'incompatible',
      reason: `capability package targets domain '${packageTargetDomain}' but is being loaded for '${targetDomainId}'`,
      declaredTargetDomain: packageTargetDomain,
      declaredApiVersion: packageTargetDomainApiVersion,
      minSupportedApiVersion,
      currentApiVersion,
    };
  }

  if (packageTargetDomainApiVersion < minSupportedApiVersion) {
    return {
      kind: 'incompatible',
      reason: `capability package targets domain API v${packageTargetDomainApiVersion}, supported range is ${minSupportedApiVersion}..${currentApiVersion}`,
      declaredTargetDomain: packageTargetDomain,
      declaredApiVersion: packageTargetDomainApiVersion,
      minSupportedApiVersion,
      currentApiVersion,
    };
  }

  if (packageTargetDomainApiVersion > currentApiVersion) {
    return {
      kind: 'incompatible',
      reason: `capability package targets domain API v${packageTargetDomainApiVersion}, supported range is ${minSupportedApiVersion}..${currentApiVersion}`,
      declaredTargetDomain: packageTargetDomain,
      declaredApiVersion: packageTargetDomainApiVersion,
      minSupportedApiVersion,
      currentApiVersion,
    };
  }

  return { kind: 'compatible' };
}
