/**
 * Field-coverage regression test for pii-exposure-in-logs.
 *
 * The check's PII_FIELD_NAMES set absorbed the field list from the retired
 * regex-based `pii-logging` check (checks-universal) during dedup. These
 * cases pin the ported categories so a future edit to the set can't silently
 * drop them. Runs the check in-process via the engine's fixture-coverage
 * helper rather than reaching into its private analyze().
 */

import { runCheckOnFixture } from '@opensip-tools/test-support';
import { describe, expect, it } from 'vitest';

import { piiExposureInLogs } from './pii-exposure-in-logs.js';

function logCall(body: string): string {
  return `import { logger } from './logger.js'\nexport function run(value: string): void {\n  logger.info({ ${body} })\n}\n`;
}

describe('pii-exposure-in-logs · ported field coverage', () => {
  // Fields inherited from the retired `pii-logging` regex check.
  const portedFields = [
    'cvv',
    'cvc',
    'passport',
    'driverLicense',
    'driver_license',
    'bankAccount',
    'bank_account',
    'routingNumber',
    'routing_number',
    'socialSecurity',
    'social_security',
  ];

  for (const field of portedFields) {
    it(`flags '${field}' in a logger call`, async () => {
      const { findings } = await runCheckOnFixture(piiExposureInLogs, {
        files: [{ path: 'handler.ts', content: logCall(`${field}: value`) }],
      });
      expect(findings).toHaveLength(1);
    });
  }

  it('still exempts a ported field wrapped in a safe sanitizer', async () => {
    const { findings } = await runCheckOnFixture(piiExposureInLogs, {
      files: [{ path: 'handler.ts', content: logCall('passport: redact(value)') }],
    });
    expect(findings).toHaveLength(0);
  });
});
