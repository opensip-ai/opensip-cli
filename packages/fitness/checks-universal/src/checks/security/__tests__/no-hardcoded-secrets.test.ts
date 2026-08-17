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

describe('no-hardcoded-secrets — false negative: URL on the line no longer suppresses detection', () => {
  // Regression: isInsideRegexLiteral counted EVERY unescaped `/` on the
  // line, including ones inside a string literal. A URL like
  // 'https://a.co/b' contributes 3 "/" — an odd count — which made the
  // heuristic believe the WHOLE rest of the line was inside a regex
  // literal, suppressing a real secret later on the same line.
  it('still flags a hardcoded bearer token next to a fetch() URL', () => {
    const src = `await fetch('https://a.co/b', { headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwx' }, cache: 'x/y' });`;
    const violations = analyze(src);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('no-hardcoded-secrets — false positive: interpolated credentials and non-credential keys', () => {
  // Regression: `[^:]+`/`[^@]+` in the postgres/mysql/mongodb pattern happily
  // matched a `${...}` interpolation placeholder, flagging an
  // ALREADY-environment-sourced connection string as if it were hardcoded.
  it('does not flag a database URL whose credentials are template interpolations', () => {
    const src =
      'export const dsn = `postgres://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}/app`;';
    expect(analyze(src)).toHaveLength(0);
  });

  // Regression: the password pattern had no leading `\b`, so it matched
  // INSIDE any identifier merely containing "password" (resetPassword,
  // confirmPassword) — firing on ordinary route constants / i18n strings.
  it('does not flag a route constant whose key merely contains "Password"', () => {
    const src = "export const ROUTES = { resetPassword: '/auth/reset-password' };";
    expect(analyze(src)).toHaveLength(0);
  });

  it('does not flag an i18n string whose key merely contains "Password"', () => {
    const src = "export const MESSAGES = { confirmPassword: 'Passwords must match' };";
    expect(analyze(src)).toHaveLength(0);
  });

  it('still flags a genuine hardcoded password assignment', () => {
    const src = "const password = 'supersecretvalue123';";
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });

  it('still flags a genuine hardcoded database connection string', () => {
    const src = "const dsn = 'postgres://admin:hunter2ishere@localhost:5432/app';";
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });
});

describe('no-hardcoded-secrets — column is 1-based (ADR-0179)', () => {
  it('reports the column as 1-based, not the raw 0-based match index', () => {
    const src = "const k = 'AKIAABCDEFGHIJKLMNOP'";
    const violations = analyzeHardcodedSecrets(src, 'test.ts');
    expect(violations[0]?.column).toBe(src.indexOf("'AKIA") + 1);
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
