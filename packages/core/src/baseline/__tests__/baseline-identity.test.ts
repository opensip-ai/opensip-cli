import { describe, expect, it } from 'vitest';

import {
  BASELINE_FORMAT_VERSION,
  formatBaselineIdentityMismatch,
  isBaselineIdentityCompatible,
  toBaselineIdentityMetadata,
} from '../baseline-identity.js';

const CURRENT = {
  fingerprintStrategyId: 'message-hash',
  fingerprintStrategyVersion: 1,
};

describe('baseline identity helpers', () => {
  describe('isBaselineIdentityCompatible', () => {
    it('returns false when stored metadata is absent', () => {
      expect(isBaselineIdentityCompatible(CURRENT, null)).toBe(false);
      expect(isBaselineIdentityCompatible(CURRENT, undefined)).toBe(false);
    });

    it('returns false when the baseline format version differs', () => {
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: 99,
          fingerprintStrategyId: 'message-hash',
          fingerprintStrategyVersion: 1,
        }),
      ).toBe(false);
    });

    it('returns false when stored strategy id or version is invalid', () => {
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: BASELINE_FORMAT_VERSION,
          fingerprintStrategyId: '',
          fingerprintStrategyVersion: 1,
        }),
      ).toBe(false);
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: BASELINE_FORMAT_VERSION,
          fingerprintStrategyId: 'message-hash',
          fingerprintStrategyVersion: 0,
        }),
      ).toBe(false);
    });

    it('returns true when stored metadata matches the current identity', () => {
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: BASELINE_FORMAT_VERSION,
          fingerprintStrategyId: 'message-hash',
          fingerprintStrategyVersion: 1,
        }),
      ).toBe(true);
    });

    it('returns false when the strategy id or version mismatches', () => {
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: BASELINE_FORMAT_VERSION,
          fingerprintStrategyId: 'byte-preserved',
          fingerprintStrategyVersion: 1,
        }),
      ).toBe(false);
      expect(
        isBaselineIdentityCompatible(CURRENT, {
          baselineFormatVersion: BASELINE_FORMAT_VERSION,
          fingerprintStrategyId: 'message-hash',
          fingerprintStrategyVersion: 2,
        }),
      ).toBe(false);
    });
  });

  describe('formatBaselineIdentityMismatch', () => {
    it('formats missing stored metadata', () => {
      const message = formatBaselineIdentityMismatch('fit', CURRENT, undefined);
      expect(message).toContain("Baseline identity for 'fit' is incompatible");
      expect(message).toContain('id=(missing)');
      expect(message).toContain('version=(missing)');
      expect(message).toContain('opensip fit --gate-save');
    });

    it('formats a stored mismatch with concrete values', () => {
      const message = formatBaselineIdentityMismatch('graph', CURRENT, {
        baselineFormatVersion: BASELINE_FORMAT_VERSION,
        fingerprintStrategyId: 'byte-preserved',
        fingerprintStrategyVersion: 2,
      });
      expect(message).toContain('byte-preserved');
      expect(message).toContain('version=2');
      expect(message).toContain('id=message-hash');
    });
  });

  describe('toBaselineIdentityMetadata', () => {
    it('projects the envelope identity into persisted metadata', () => {
      expect(toBaselineIdentityMetadata(CURRENT)).toEqual({
        baselineFormatVersion: BASELINE_FORMAT_VERSION,
        fingerprintStrategyId: 'message-hash',
        fingerprintStrategyVersion: 1,
      });
    });
  });
});
