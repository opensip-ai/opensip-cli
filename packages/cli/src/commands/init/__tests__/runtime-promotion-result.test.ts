import { describe, expect, it } from 'vitest';

import { rolledBackResult } from '../runtime-promotion-result.js';

import type { RuntimePromotionPreflightSelected } from '../runtime-promotion-preflight.js';

const PREFLIGHT = {
  status: 'selected',
  route: 'authored-only',
  effectiveConflict: 'abort',
  source: {
    classification: 'none',
    cacheKey: null,
    generationDigest: null,
    markerSha256: null,
    rootIdentity: null,
  },
  destinationParentPreexisting: false,
  destinationRuntimePreexisting: false,
  destinationRootIdentity: null,
  destinationParentDir: '/project/opensip-cli',
  destinationRuntimeDir: '/project/opensip-cli/.runtime',
  preliminaryEquality: 'not-required',
  revalidation: {
    projectRoot: '/project',
    coordinationKey: 'a'.repeat(24),
  } as RuntimePromotionPreflightSelected['revalidation'],
} satisfies RuntimePromotionPreflightSelected;

describe('fresh runtime promotion results', () => {
  it('retains rolled-back terminal truth while reporting pending cleanup', () => {
    const result = rolledBackResult({
      preflight: PREFLIGHT,
      authored: null,
      sourcePreserved: false,
      cleanupPending: true,
      startedAt: 10,
      now: () => 13,
    });

    expect(result).toMatchObject({
      status: 'rolled-back',
      cleanupPending: true,
      sourcePreserved: false,
      sourceRetired: false,
      durationMs: 3,
      reasonCode: 'operation-failed',
      nextCommand: 'opensip init',
    });
  });
});
