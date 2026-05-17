/**
 * @fileoverview Direct unit tests for the observability-coverage logger
 * detector helper module.
 *
 * Exercises:
 *   - logger.* / this.logger.* / direct logToFitnessFile/logToCLIFile detection
 *   - line-range filtering (out-of-range calls are excluded)
 *   - non-logger property access calls (e.g., db.info) are ignored
 *   - fileImportsLogger over import-path patterns and direct identifiers
 */

import { describe, expect, it } from 'vitest'

import { detectLoggerCalls, fileImportsLogger } from '../logger-detector.js'

describe('logger-detector — detectLoggerCalls', () => {
  it('returns an empty array when the source has no parseable AST', () => {
    // Empty path yields a falsy SourceFile from getSharedSourceFile in some
    // configurations; even when it parses, an empty body has no calls.
    expect(detectLoggerCalls('', 'empty.ts', 1, 5)).toEqual([])
  })

  it('detects bare-identifier logger calls (logger.info)', () => {
    const src = `
      export function f() {
        logger.info({ msg: 'hi' })
      }
    `
    const calls = detectLoggerCalls(src, 'a.ts', 1, 10)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.level).toBe('info')
  })

  it('detects this.logger.* calls inside class methods', () => {
    const src = `
      export class S {
        run() {
          this.logger.warn({ msg: 'hi' })
          this.logger.error('boom')
        }
      }
    `
    const calls = detectLoggerCalls(src, 'class.ts', 1, 20)
    expect(calls.map((c) => c.level).sort()).toEqual(['error', 'warn'])
  })

  it('excludes calls outside the requested line range', () => {
    const src = [
      'function a() {',                  // line 1
      '  logger.info({ msg: 1 })',       // line 2  (in range)
      '}',                                // line 3
      'function b() {',                  // line 4
      '  logger.warn({ msg: 2 })',       // line 5  (out of range)
      '}',                                // line 6
    ].join('\n')

    const calls = detectLoggerCalls(src, 'range.ts', 1, 3)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.level).toBe('info')
  })

  it('detects logToFitnessFile / logToCLIFile direct calls', () => {
    const src = `
      logToFitnessFile({ msg: 'a' })
      logToCLIFile({ msg: 'b' })
    `
    const calls = detectLoggerCalls(src, 'direct.ts', 1, 10)
    expect(calls).toHaveLength(2)
    // Direct calls are normalized to 'info' level.
    expect(calls.every((c) => c.level === 'info')).toBe(true)
  })

  it('does not match non-logger property access calls', () => {
    const src = `
      const db = { info(_: unknown) {}, warn(_: unknown) {} }
      db.info({ msg: 'no' })
      db.warn({ msg: 'no' })
    `
    expect(detectLoggerCalls(src, 'no.ts', 1, 10)).toEqual([])
  })

  it('ignores property-access calls whose method is not a known logger level', () => {
    const src = `
      logger.trace({ msg: 'unknown level' })
      logger.fatal({ msg: 'unknown level' })
    `
    // Detector recognizes only info/warn/error/debug.
    expect(detectLoggerCalls(src, 'level.ts', 1, 10)).toEqual([])
  })
})

describe('logger-detector — fileImportsLogger', () => {
  it('detects import-from-/logger paths', () => {
    expect(fileImportsLogger(`import { logger } from '@some/pkg/logger'`)).toBe(true)
    expect(fileImportsLogger(`import x from '../utils/logger'`)).toBe(true)
  })

  it('detects logToFitnessFile / logToCLIFile direct identifier usage', () => {
    expect(fileImportsLogger('export const f = () => logToFitnessFile({})')).toBe(true)
    expect(fileImportsLogger('export const g = () => logToCLIFile({})')).toBe(true)
  })

  it('returns false when neither pattern is present', () => {
    expect(fileImportsLogger("import x from 'react'\nexport const x = 1")).toBe(false)
  })
})
