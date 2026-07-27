/**
 * The recovery classifier must key on the raiser's declared condition, not on its prose.
 *
 * It used to substring-match user-facing messages
 * (`message.includes('exceeds its bounded size')`), which made every one of those sentences
 * load-bearing: rewording one silently reclassified the failure into `state-ambiguous` — the
 * most conservative and least actionable arm — with nothing to catch it.
 */

import { describe, expect, it } from 'vitest';

import {
  journalError,
  recoveryRequired,
} from '../runtime-promotion-journal-controller-validation.js';
import { recoveryFailureReason } from '../runtime-promotion-recovery-common.js';

describe('recoveryFailureReason — classification is by condition, not prose', () => {
  it('classifies an oversize journal from its condition', () => {
    const error = recoveryRequired('any wording at all', undefined, 'journal-oversize');
    expect(recoveryFailureReason(error, undefined)).toBe('journal-oversize');
  });

  it('classifies a foreign-key journal from its condition', () => {
    const error = recoveryRequired('any wording at all', undefined, 'journal-key-mismatch');
    expect(recoveryFailureReason(error, undefined)).toBe('journal-key-mismatch');
  });

  it('classifies a malformed journal from its condition', () => {
    const error = journalError('any wording at all', undefined, 'journal-malformed');
    expect(recoveryFailureReason(error, undefined)).toBe('journal-malformed');
  });

  it('does NOT classify on message text alone', () => {
    // The old implementation returned 'journal-oversize' for this: the phrase was the contract.
    // An untyped error carrying the same words must now fall through to the conservative arm.
    const error = new Error('The promotion journal exceeds its bounded size.');
    expect(recoveryFailureReason(error, undefined)).toBe('state-ambiguous');
  });

  it('falls back to state-ambiguous for an unlabelled failure', () => {
    expect(recoveryFailureReason(new Error('something else'), undefined)).toBe('state-ambiguous');
  });
});
