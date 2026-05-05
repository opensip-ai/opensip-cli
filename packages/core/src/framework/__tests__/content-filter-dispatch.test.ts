/**
 * @fileoverview Pin the contentFilter dispatch in define-check.ts and
 * file-accessor.ts. Two modes are intentional and distinct:
 *
 *   - `code-only`             → strings blanked, COMMENTS PRESERVED.
 *                               Use when a rule reads comment markers
 *                               (e.g. `// @swallow-ok`).
 *   - `no-strings-no-comments` → both blanked. Use when the same
 *                                forbidden phrase could appear in a
 *                                comment and would false-fire.
 *
 * Mixing them was the bug behind a brief 2026-05-05 mis-fix that mapped
 * both modes to codeNoComments, breaking every rule that scans comments
 * for directives. This test pins the contract.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createFileAccessor } from '../file-accessor.js'

async function writeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-dispatch-'))
  const filePath = join(dir, 'sample.ts')
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

describe('FileAccessor contentFilter dispatch', () => {
  describe('code-only mode (strings blanked, comments preserved)', () => {
    it('preserves line-comment text so rules can scan markers', async () => {
      const filePath = await writeTempFile(
        `const a = 1\n// @swallow-ok intentional fallthrough\nconst b = 2`,
      )
      const accessor = createFileAccessor([filePath], { contentFilter: 'code-only' })
      const content = await accessor.read(filePath)

      expect(content).toContain('@swallow-ok')
      expect(content).toContain('const a = 1')
      expect(content).toContain('const b = 2')
    })

    it('preserves block-comment text including JSDoc directives', async () => {
      const filePath = await writeTempFile(
        `/** @deprecated use Y instead */\nexport function legacy() {}`,
      )
      const accessor = createFileAccessor([filePath], { contentFilter: 'code-only' })
      const content = await accessor.read(filePath)

      expect(content).toContain('@deprecated')
      expect(content).toContain('export function legacy')
    })

    it('blanks string-literal contents', async () => {
      const filePath = await writeTempFile(`const url = 'phrase_in_string'`)
      const accessor = createFileAccessor([filePath], { contentFilter: 'code-only' })
      const content = await accessor.read(filePath)

      expect(content).not.toContain('phrase_in_string')
      expect(content).toContain('const url = ')
    })
  })

  describe('no-strings-no-comments mode (both blanked)', () => {
    it('blanks comment text so rules don\'t false-fire on prose', async () => {
      const filePath = await writeTempFile(
        `const a = 1\n// forbidden_phrase_in_comment\nconst b = 2`,
      )
      const accessor = createFileAccessor([filePath], { contentFilter: 'no-strings-no-comments' })
      const content = await accessor.read(filePath)

      expect(content).not.toContain('forbidden_phrase_in_comment')
      expect(content).toContain('const a = 1')
      expect(content).toContain('const b = 2')
    })

    it('blanks both strings and comments in the same content', async () => {
      const filePath = await writeTempFile(
        `const url = 'phrase_in_string' // phrase_in_comment`,
      )
      const accessor = createFileAccessor([filePath], { contentFilter: 'no-strings-no-comments' })
      const content = await accessor.read(filePath)

      expect(content).not.toContain('phrase_in_string')
      expect(content).not.toContain('phrase_in_comment')
    })
  })

  describe('default (raw) — no filter applied', () => {
    it('preserves both strings and comments verbatim', async () => {
      const src = `const url = 'phrase'\n// also phrase`
      const filePath = await writeTempFile(src)
      const accessor = createFileAccessor([filePath]) // no contentFilter → raw passthrough
      const content = await accessor.read(filePath)

      expect(content).toBe(src)
    })
  })
})
