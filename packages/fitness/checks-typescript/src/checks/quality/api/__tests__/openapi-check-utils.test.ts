/**
 * @fileoverview Unit tests for createOpenApiParseOutput, the shared
 * factory used by OpenAPI freshness checks to convert subprocess output
 * into a CheckViolation array.
 */

import { describe, expect, it } from 'vitest'

import { createOpenApiParseOutput } from '../openapi-check-utils.js'

describe('createOpenApiParseOutput', () => {
  const config = {
    message: 'OpenAPI spec is stale',
    suggestion: 'Run pnpm openapi:regenerate',
    type: 'openapi-freshness',
    filePath: 'spec/openapi.yml',
  }

  it('returns an empty array when the command exited cleanly', () => {
    const parse = createOpenApiParseOutput(config)
    expect(parse('any output', 'any stderr', 0)).toEqual([])
  })

  it('returns a single violation when the command failed', () => {
    const parse = createOpenApiParseOutput(config)
    const violations = parse('diff in line 5', '', 1)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      line: 1,
      message: config.message,
      suggestion: config.suggestion,
      type: config.type,
      severity: 'error',
      filePath: config.filePath,
    })
    expect(violations[0]?.match).toBe('diff in line 5')
  })

  it('combines stderr and stdout (stderr first) and truncates to 200 chars', () => {
    const parse = createOpenApiParseOutput(config)
    const longStdout = 'A'.repeat(400)
    const violations = parse(longStdout, 'ERR-PREFIX', 2)
    expect(violations).toHaveLength(1)
    const match = violations[0]?.match ?? ''
    expect(match.length).toBeLessThanOrEqual(200)
    // stderr is concatenated before stdout, so the first chars come from stderr
    expect(match.startsWith('ERR-PREFIX')).toBe(true)
  })

  it('handles empty stdout/stderr by producing an empty match', () => {
    const parse = createOpenApiParseOutput(config)
    const violations = parse('', '', 99)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.match).toBe('')
  })
})
