import { describe, expect, it } from 'vitest';

import {
  CLI_SUPPORTED_SCHEMA_VERSION,
  CLOUD_WIRE_CONTRACT_VERSION,
  COMPATIBILITY_CONTRACT_CLASSES,
  COMPATIBILITY_POLICIES,
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

  it('carries docs and breaking-change gates for every class', () => {
    for (const policy of COMPATIBILITY_POLICIES) {
      expect(policy.docsPath).toMatch(/^docs\/public\//);
      expect(policy.breakingChangeRequires.length).toBeGreaterThan(0);
      expect(policy.deprecationWindow.length).toBeGreaterThan(0);
    }
  });
});
