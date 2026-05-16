/**
 * @fileoverview Regression tests for `no-hardcoded-secrets` FP fix.
 *
 * The 1.0.7 release added two filters: (1) skip matches inside a
 * regex literal (the file IS the redactor), (2) skip matches that
 * are redaction placeholders (`***`, `[REDACTED]`, `XXXX`, etc.).
 */

import { describe, expect, it } from 'vitest'

import { analyzeHardcodedSecrets } from '../no-hardcoded-secrets.js'

function analyze(src: string): readonly { line: number }[] {
  return analyzeHardcodedSecrets(src, 'test.ts')
}

describe('no-hardcoded-secrets — FP regression suite (1.0.7)', () => {
  it('does NOT flag a regex literal that detects PRIVATE KEY blobs', () => {
    // Pre-1.0.7 this fired because the regex pattern body contains
    // "-----BEGIN PRIVATE KEY-----" literally.
    const src = String.raw`
      const REDACTORS = [
        [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'],
      ]
    `
    expect(analyze(src)).toHaveLength(0)
  })

  it('does NOT flag a redaction placeholder string with ***', () => {
    const src = `
      const REDACTED_KEY = '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'
    `
    expect(analyze(src)).toHaveLength(0)
  })

  it('STILL flags a real PRIVATE KEY literal', () => {
    const src = `
      const KEY = '-----BEGIN PRIVATE KEY-----'
    `
    expect(analyze(src).length).toBeGreaterThanOrEqual(1)
  })
})
