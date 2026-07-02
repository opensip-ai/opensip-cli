import { describe, expect, it } from 'vitest';

import { classifyEvidenceDivergence } from './evidence-divergence.js';

describe('classifyEvidenceDivergence', () => {
  it('promotes verdict disagreement to verdict-changing', () => {
    expect(
      classifyEvidenceDivergence({
        cliVerdict: true,
        cloudVerdict: false,
        identityMatch: true,
      }),
    ).toBe('verdict-changing');
  });

  it('treats identity drift under the same verdict as sub-verdict', () => {
    expect(
      classifyEvidenceDivergence({
        cliVerdict: false,
        cloudVerdict: false,
        identityMatch: false,
      }),
    ).toBe('sub-verdict');
  });

  it('suppresses pure line/message/order drift as cosmetic', () => {
    expect(
      classifyEvidenceDivergence({
        cliVerdict: true,
        cloudVerdict: true,
        identityMatch: true,
        changedFields: ['line', 'message', 'ordering'],
      }),
    ).toBe('cosmetic');
  });

  it('returns none when matching evidence has no changed fields', () => {
    expect(
      classifyEvidenceDivergence({
        cliVerdict: true,
        cloudVerdict: true,
        identityMatch: true,
      }),
    ).toBe('none');
  });
});
