import { describe, expect, it } from 'vitest';

import { scrubErrorMessage } from '../scrub-error-message.js';

describe('scrubErrorMessage', () => {
  it('redacts api key patterns', () => {
    expect(scrubErrorMessage('failed api_key=sk-secret123')).toContain('[redacted]');
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(600);
    expect(scrubErrorMessage(long).length).toBeLessThanOrEqual(501);
  });

  it('truncates long multiline messages after redaction', () => {
    const multiline = Array.from({ length: 180 }, (_, i) => `line-${i}`).join('\n');
    const scrubbed = scrubErrorMessage(`api_key=secret\n${multiline}`);
    expect(scrubbed).toContain('[redacted]');
    expect(scrubbed.endsWith('…')).toBe(true);
    expect(scrubbed.length).toBe(501);
  });
});
