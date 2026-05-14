import { describe, it, expect } from 'vitest'

import { parseDirectiveLine } from '../directive-inventory.js'

describe('parseDirectiveLine', () => {
  describe('line comments (// form)', () => {
    it('parses @fitness-ignore-file with reason', () => {
      const result = parseDirectiveLine('// @fitness-ignore-file no-console-log -- debug scaffold for this module')
      expect(result).toEqual({ type: 'file', checkId: 'no-console-log', reason: 'debug scaffold for this module' })
    })

    it('parses @fitness-ignore-next-line without reason', () => {
      const result = parseDirectiveLine('// @fitness-ignore-next-line no-any-types')
      expect(result).toEqual({ type: 'next-line', checkId: 'no-any-types', reason: null })
    })

    it('rejects lines without the directive prefix', () => {
      expect(parseDirectiveLine('// just a comment')).toBeNull()
      expect(parseDirectiveLine('const x = 1;')).toBeNull()
    })
  })

  describe('block comments (/* form) — parity with suppression parser', () => {
    it('parses single-line block directive with reason', () => {
      const result = parseDirectiveLine('/* @fitness-ignore-file no-console-log -- legacy file */')
      expect(result).toEqual({ type: 'file', checkId: 'no-console-log', reason: 'legacy file' })
    })

    it('parses single-line block directive without reason', () => {
      const result = parseDirectiveLine('/* @fitness-ignore-next-line no-any-types */')
      expect(result).toEqual({ type: 'next-line', checkId: 'no-any-types', reason: null })
    })

    it('strips trailing whitespace before */', () => {
      const result = parseDirectiveLine('/* @fitness-ignore-file some-check   */')
      expect(result).toEqual({ type: 'file', checkId: 'some-check', reason: null })
    })
  })

  describe('rejection cases', () => {
    it('rejects directive without comment marker', () => {
      expect(parseDirectiveLine('@fitness-ignore-file foo')).toBeNull()
    })

    it('rejects checkId with spaces', () => {
      expect(parseDirectiveLine('// @fitness-ignore-file foo bar baz')).toBeNull()
    })

    it('rejects empty checkId', () => {
      expect(parseDirectiveLine('// @fitness-ignore-file ')).toBeNull()
    })
  })
})
