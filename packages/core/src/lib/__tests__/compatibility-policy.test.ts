import { describe, expect, it } from 'vitest';

import {
  CLI_SUPPORTED_SCHEMA_VERSION,
  CLOUD_WIRE_CONTRACT_VERSION,
  COMPATIBILITY_CONTRACT_CLASSES,
  COMPATIBILITY_POLICIES,
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  PLUGIN_API_VERSION,
  PUBLIC_JSON_CONTRACT_VERSION,
  assertCompatibilityPoliciesComplete,
  findCompatibilityPolicy,
} from '../../index.js';

describe('compatibility policy registry', () => {
  it('has exactly one policy per contract class', () => {
    expect(() => assertCompatibilityPoliciesComplete()).not.toThrow();
    expect(COMPATIBILITY_POLICIES.map((policy) => policy.class).sort()).toEqual(
      [...COMPATIBILITY_CONTRACT_CLASSES].sort(),
    );
  });

  it('tracks live config, public-json, cloud-wire, and plugin epochs', () => {
    expect(findCompatibilityPolicy('project-config')?.version).toBe(CLI_SUPPORTED_SCHEMA_VERSION);
    expect(findCompatibilityPolicy('public-json')?.version).toBe(PUBLIC_JSON_CONTRACT_VERSION);
    expect(findCompatibilityPolicy('cloud-wire')?.version).toBe(CLOUD_WIRE_CONTRACT_VERSION);
    expect(findCompatibilityPolicy('tool-plugin-api')?.version).toBe(PLUGIN_API_VERSION);
  });

  it('registers the platform-support class bound to the live contract version (Plan 02)', () => {
    // The macOS GA support registry participates in the same contract-class
    // registry as every other public surface: it is a first-class member of the
    // closed class list, its policy version tracks the live core constant (so a
    // constant/policy drift is caught by the compatibility matrix), and it points
    // at the generated supported-platforms reference.
    expect(COMPATIBILITY_CONTRACT_CLASSES).toContain('platform-support');
    const policy = findCompatibilityPolicy('platform-support');
    expect(policy).toBeDefined();
    expect(policy?.version).toBe(PLATFORM_SUPPORT_CONTRACT_VERSION);
    expect(policy?.ownerPackage).toBe('@opensip-cli/root');
    expect(policy?.stability).toBe('policy-only');
    expect(policy?.docsPath).toBe('docs/public/70-reference/17-supported-platforms.md');
    // A supported tuple change restarts burn-in — the change-gate says so.
    expect(policy?.breakingChangeRequires).toContain('PLATFORM_SUPPORT_CONTRACT_VERSION bump');
  });

  it('carries docs and breaking-change gates for every class', () => {
    for (const policy of COMPATIBILITY_POLICIES) {
      expect(policy.docsPath).toMatch(/^docs\/public\//);
      expect(policy.breakingChangeRequires.length).toBeGreaterThan(0);
      expect(policy.deprecationWindow.length).toBeGreaterThan(0);
    }
  });

  it('fails closed for unknown, duplicate, incomplete, and missing policy entries', () => {
    const mutable = COMPATIBILITY_POLICIES as (typeof COMPATIBILITY_POLICIES)[number][];
    const original = [...mutable];
    const expectFailure = (
      policies: readonly (typeof COMPATIBILITY_POLICIES)[number][],
      message: RegExp,
    ): void => {
      mutable.splice(0, mutable.length, ...policies);
      try {
        expect(() => assertCompatibilityPoliciesComplete()).toThrow(message);
      } finally {
        mutable.splice(0, mutable.length, ...original);
      }
    };

    expectFailure(
      [{ ...original[0], class: 'future-contract' as never }, ...original.slice(1)],
      /Unknown compatibility contract class/u,
    );
    expectFailure(
      [original[0], { ...original[1], class: original[0].class }, ...original.slice(2)],
      /Duplicate compatibility policy/u,
    );
    expectFailure(
      [{ ...original[0], breakingChangeRequires: [] }, ...original.slice(1)],
      /has no breaking-change gate/u,
    );
    expectFailure([{ ...original[0], docsPath: '' }, ...original.slice(1)], /has no docs path/u);
    expectFailure(original.slice(0, -1), /Missing compatibility policies/u);
    expect(findCompatibilityPolicy('future-contract' as never)).toBeUndefined();
  });
});
