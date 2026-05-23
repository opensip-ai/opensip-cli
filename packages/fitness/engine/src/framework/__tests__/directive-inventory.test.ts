import { describe, it, expect } from 'vitest'

import { parseDirectiveLine } from '../directive-inventory.js'
import { parseFileIgnoreDirective, parseIgnoreDirectives } from '../directive-parsing.js'

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

  describe('HTML comments (<!-- form)', () => {
    it('parses single-line HTML directive with reason', () => {
      const result = parseDirectiveLine('<!-- @fitness-ignore-file md-check -- doc fixture -->')
      expect(result).toEqual({ type: 'file', checkId: 'md-check', reason: 'doc fixture' })
    })

    it('parses HTML directive without reason', () => {
      const result = parseDirectiveLine('<!-- @fitness-ignore-next-line md-check -->')
      expect(result).toEqual({ type: 'next-line', checkId: 'md-check', reason: null })
    })
  })

  describe('hash comments (# form)', () => {
    it('parses hash directive with reason', () => {
      const result = parseDirectiveLine('# @fitness-ignore-file yaml-check -- ci config exempt')
      expect(result).toEqual({ type: 'file', checkId: 'yaml-check', reason: 'ci config exempt' })
    })

    it('parses hash directive without reason', () => {
      const result = parseDirectiveLine('# @fitness-ignore-next-line yaml-check')
      expect(result).toEqual({ type: 'next-line', checkId: 'yaml-check', reason: null })
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

    it('rejects empty checkId before the " -- " separator', () => {
      // separatorIndex !== -1 path with empty checkId — exercises the
      // post-separator validation branch.
      expect(parseDirectiveLine('// @fitness-ignore-file  -- reason here')).toBeNull()
    })

    it('rejects checkId with embedded spaces before the " -- " separator', () => {
      expect(parseDirectiveLine('// @fitness-ignore-file foo bar -- reason')).toBeNull()
    })
  })
})

// `isWeakReason` and `extractGroup` were v2 internal helpers that
// audit's D5 phase (comment-openers consolidation) refactored out of
// the public surface. Their behavior is now exercised through
// parseDirectiveLine and the directive parsers in `_directives/`.

describe('inventory + suppression parity across comment styles', () => {
  // Regression for the pre-D5 bug where HTML and hash directives
  // suppressed findings (handled by directive-parsing.ts via the
  // shared COMMENT_OPENERS table) but vanished from the inventory
  // (handled by directive-inventory.ts via a stricter `// ` / `/* `
  // check). Now both consume the shared table.
  const cases: { name: string; line: string }[] = [
    { name: 'line comment',  line: '// @fitness-ignore-file shared-fixture-check' },
    { name: 'block comment', line: '/* @fitness-ignore-file shared-fixture-check */' },
    { name: 'HTML comment',  line: '<!-- @fitness-ignore-file shared-fixture-check -->' },
    { name: 'hash comment',  line: '# @fitness-ignore-file shared-fixture-check' },
  ]

  for (const { name, line } of cases) {
    it(`${name}: file directive both suppresses AND surfaces in the inventory`, () => {
      // (a) Suppresses: directive-parsing recognizes it.
      expect(parseFileIgnoreDirective(line, 'shared-fixture-check')).toBe(true)
      // (b) Surfaces: directive-inventory parses the same line.
      const parsed = parseDirectiveLine(line)
      expect(parsed).not.toBeNull()
      expect(parsed?.type).toBe('file')
      expect(parsed?.checkId).toBe('shared-fixture-check')
    })
  }

  it('next-line directive: hash form surfaces in the inventory and suppresses', () => {
    const line = '# @fitness-ignore-next-line shared-fixture-check'
    expect(parseIgnoreDirectives(`${line}\nfoo()`, 'shared-fixture-check').size).toBe(1)
    const parsed = parseDirectiveLine(line)
    expect(parsed?.type).toBe('next-line')
  })
})
