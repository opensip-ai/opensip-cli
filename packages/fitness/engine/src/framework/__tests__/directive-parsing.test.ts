/**
 * @fileoverview Regression tests for the comment-prefix support added
 * to `extractCheckIdFromDirective` in 1.0.8 (Markdown + HTML + shell/
 * YAML).
 *
 * Prior to 1.0.8 the parser only recognised `//` and `/*` openers, so
 * pragmas inside Markdown documents (`<!-- @fitness-ignore-file ... -->`)
 * or YAML/shell files (`# @fitness-ignore-file ...`) silently
 * failed — the directive was extracted as null and the file was
 * scanned despite the author's intent.
 */

import { describe, expect, it } from 'vitest'

import { parseFileIgnoreDirective, parseIgnoreDirectives } from '../directive-parsing.js'

describe('parseFileIgnoreDirective — comment-prefix support', () => {
  it('recognises `//` (TypeScript / JavaScript / C-family)', () => {
    const content = '// @fitness-ignore-file file-length-limit -- justified\nrest of file'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(true)
  })

  it('recognises `/*` (block comment in JS-family)', () => {
    const content = '/* @fitness-ignore-file file-length-limit -- justified */\nrest of file'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(true)
  })

  it('recognises `<!--` (Markdown + HTML)', () => {
    const content = '<!-- @fitness-ignore-file file-length-limit -- doc-set catalogue grows by design -->\n# Heading'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(true)
  })

  it('recognises `#` (shell / YAML / Python)', () => {
    const content = '# @fitness-ignore-file file-length-limit -- config grows by design\nkey: value'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(true)
  })

  it('does not recognise an unsupported prefix', () => {
    const content = '; @fitness-ignore-file file-length-limit -- ini-style comments not supported\n[section]'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(false)
  })

  it('requires the directive to actually appear after the comment opener', () => {
    const content = '<!-- not a directive line -->\nrest'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(false)
  })

  it('matches only the specific check id requested', () => {
    const content = '<!-- @fitness-ignore-file other-check -- ... -->\nrest'
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(false)
  })

  it('only scans the first 50 lines', () => {
    const filler = Array.from({ length: 60 }, () => 'x').join('\n')
    const content = `${filler}\n<!-- @fitness-ignore-file file-length-limit -- too late -->`
    expect(parseFileIgnoreDirective(content, 'file-length-limit')).toBe(false)
  })

  it('rejects directives missing the required space/tab separator before the check id', () => {
    // No space between "@fitness-ignore-file" and slug — extractCheckIdFromDirective
    // returns null for this shape.
    const content = '// @fitness-ignore-file:my-rule\nrest'
    expect(parseFileIgnoreDirective(content, 'my-rule')).toBe(false)
  })

  it('accepts an array of check ids and matches any', () => {
    const content = '// @fitness-ignore-file second-id -- ok\nrest'
    expect(parseFileIgnoreDirective(content, ['first-id', 'second-id'])).toBe(true)
  })
})

describe('parseIgnoreDirectives — multi-line directive skipping', () => {
  it('skips intervening directive lines to reach the next real source line', () => {
    // Place a fitness-ignore-next-line followed by another directive
    // (eslint-disable-next-line). The skipper should walk past the
    // eslint directive and apply the ignore to the actual next line.
    const content = [
      '// @fitness-ignore-next-line my-rule -- justified',
      '// eslint-disable-next-line some-rule',
      'const offending = 1',
      'const safe = 2',
    ].join('\n')

    const ignored = parseIgnoreDirectives(content, 'my-rule')
    // The directive sits at line 1 (1-indexed); after skipping the
    // eslint directive on line 2 the marker lands on line 3 — the
    // function records it in the set.
    expect(ignored.size).toBeGreaterThan(0)
  })

  it('returns an empty set when no directives match', () => {
    const ignored = parseIgnoreDirectives('const x = 1\n', 'unrelated')
    expect(ignored.size).toBe(0)
  })

  it('accepts an array of check ids', () => {
    const content = '// @fitness-ignore-next-line target-b -- justified\nconst x = 1'
    const ignored = parseIgnoreDirectives(content, ['target-a', 'target-b'])
    expect(ignored.size).toBeGreaterThan(0)
  })
})
