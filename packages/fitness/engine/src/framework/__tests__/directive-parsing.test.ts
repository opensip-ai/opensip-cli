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

import { parseFileIgnoreDirective } from '../directive-parsing.js'

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
})
