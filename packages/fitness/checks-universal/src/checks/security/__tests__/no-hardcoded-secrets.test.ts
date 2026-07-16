/**
 * @fileoverview Regression tests for `no-hardcoded-secrets` FP fix.
 *
 * The 1.0.7 release added two filters: (1) skip matches inside a
 * regex literal (the file IS the redactor), (2) skip matches that
 * are redaction placeholders (`***`, `[REDACTED]`, `XXXX`, etc.).
 */

import { describe, expect, it } from 'vitest';

import {
  analyzeHardcodedSecrets,
  analyzeHardcodedSecretsForCheck,
} from '../no-hardcoded-secrets.js';

function analyze(src: string): readonly { line: number }[] {
  return analyzeHardcodedSecrets(src, 'test.ts');
}

describe('no-hardcoded-secrets — FP regression suite (1.0.7)', () => {
  it('does NOT flag a regex literal that detects PRIVATE KEY blobs', () => {
    // Pre-1.0.7 this fired because the regex pattern body contains
    // "-----BEGIN PRIVATE KEY-----" literally.
    const src = String.raw`
      const REDACTORS = [
        [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'],
      ]
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag a redaction placeholder string with ***', () => {
    const src = `
      const REDACTED_KEY = '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('STILL flags a real PRIVATE KEY literal', () => {
    const src = `
      const KEY = '-----BEGIN PRIVATE KEY-----'
    `;
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });
});

describe('no-hardcoded-secrets — production-only test-file skip', () => {
  // The content-specific patterns (AWS/Stripe/etc.) only work because the check
  // declares contentFilter: 'raw'; under 'strip-strings' the string interior
  // would be blanked and this secret would go undetected. Detecting it here
  // guards that config.
  const awsKey = `const k = 'AKIAABCDEFGHIJKLMNOP'`;

  it('detects a hardcoded secret in a PRODUCTION source file', () => {
    expect(
      analyzeHardcodedSecretsForCheck(awsKey, 'src/aws-config.ts').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('skips test files, which legitimately embed fake fixture secrets', () => {
    expect(analyzeHardcodedSecretsForCheck(awsKey, 'src/aws-config.test.ts')).toHaveLength(0);
    expect(analyzeHardcodedSecretsForCheck(awsKey, 'src/__tests__/aws-config.ts')).toHaveLength(0);
  });
});
