import { type ImpactTrust, type SignalEnvelope } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { verificationFromEnvelope, withProcessExitGuard } from '../suite-step-helpers.js';

const TRUST: ImpactTrust = {
  coverage: 'full',
  fallback: 'targeted',
  fullyVerified: true,
  uncertainties: [],
};

function envelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    verification: undefined,
    signals: [],
    ...overrides,
  } as SignalEnvelope;
}

describe('suite step helpers', () => {
  describe('verificationFromEnvelope', () => {
    it('returns undefined when no envelope or valid trust metadata is available', () => {
      expect(verificationFromEnvelope(undefined)).toBeUndefined();
      expect(
        verificationFromEnvelope(
          envelope({
            verification: {
              coverage: 'unsupported',
              fallback: 'targeted',
              fullyVerified: true,
              uncertainties: [],
            } as unknown as ImpactTrust,
            signals: [
              {
                metadata: {
                  trust: {
                    coverage: 'full',
                    fallback: 'bad',
                    fullyVerified: true,
                    uncertainties: [],
                  },
                },
              },
              {
                metadata: {
                  trust: {
                    coverage: 'partial',
                    fallback: 'full-run',
                    fullyVerified: 'yes',
                    uncertainties: [],
                  },
                },
              },
              {
                metadata: {
                  trust: {
                    coverage: 'unknown',
                    fallback: 'targeted',
                    fullyVerified: false,
                    uncertainties: 'not-array',
                  },
                },
              },
              // Deliberately malformed trust metadata to exercise the validation reject path.
            ] as unknown as SignalEnvelope['signals'],
          }),
        ),
      ).toBeUndefined();
    });

    it('prefers valid envelope-level verification over signal metadata', () => {
      const fallbackTrust: ImpactTrust = {
        coverage: 'partial',
        fallback: 'full-run',
        fullyVerified: false,
        uncertainties: [],
      };

      expect(
        verificationFromEnvelope(
          envelope({
            verification: TRUST,
            // Minimal signal stub carrying only the trust metadata under test.
            signals: [{ metadata: { trust: fallbackTrust } }] as unknown as SignalEnvelope['signals'],
          }),
        ),
      ).toBe(TRUST);
    });

    it('falls back to valid signal trust metadata', () => {
      expect(
        verificationFromEnvelope(
          envelope({
            // Minimal signal stubs: one invalid trust, one valid — exercises fallback selection.
            signals: [
              { metadata: { trust: { coverage: 'nope' } } },
              { metadata: { trust: TRUST } },
            ] as unknown as SignalEnvelope['signals'],
          }),
        ),
      ).toBe(TRUST);
    });
  });

  describe('withProcessExitGuard', () => {
    it('returns normal handler results and restores process.exit', async () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- identity is what this guard promises to restore.
      const original = process.exit;

      await expect(
        withProcessExitGuard(
          () => Promise.resolve(7),
          () => undefined,
        ),
      ).resolves.toBe(7);
      expect((process as unknown as { exit: unknown }).exit).toBe(original);
    });

    it('converts direct process.exit calls into step exit codes', async () => {
      const observed: number[] = [];

      await expect(
        withProcessExitGuard(
          async () => {
            await Promise.resolve();
            process.exit(2);
          },
          (code) => observed.push(code),
        ),
      ).resolves.toBe(2);
      await expect(
        withProcessExitGuard(
          async () => {
            await Promise.resolve();
            process.exit();
          },
          (code) => observed.push(code),
        ),
      ).resolves.toBe(0);
      expect(observed).toEqual([2, 0]);
    });

    it('rethrows ordinary errors and restores process.exit', async () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- identity is what this guard promises to restore.
      const original = process.exit;

      await expect(
        withProcessExitGuard(
          async () => {
            await Promise.resolve();
            throw new Error('boom');
          },
          () => undefined,
        ),
      ).rejects.toThrow('boom');
      expect((process as unknown as { exit: unknown }).exit).toBe(original);
    });
  });
});
