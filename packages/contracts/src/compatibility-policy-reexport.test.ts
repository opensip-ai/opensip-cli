import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_POLICIES,
  PUBLIC_JSON_CONTRACT_VERSION,
  findCompatibilityPolicy,
} from './index.js';

describe('contracts compatibility policy facade', () => {
  it('re-exports the platform compatibility registry from core', () => {
    expect(COMPATIBILITY_POLICIES.length).toBeGreaterThan(0);
    expect(findCompatibilityPolicy('public-json')?.version).toBe(PUBLIC_JSON_CONTRACT_VERSION);
    expect(findCompatibilityPolicy('cloud-wire')?.ownerPackage).toBe('@opensip-cli/core');
  });
});
