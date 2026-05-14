import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileCache } from '../file-cache.js'
import { PathMatcher } from '../path-matcher.js'
import { createExecutionContext } from '../execution-context.js'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-exec-ctx-'))
})

afterEach(() => {
  fileCache.clear()
  rmSync(testDir, { recursive: true, force: true })
})

describe('createExecutionContext > matchFiles fileCache fallback', () => {
  // Regression test for the scope-resolver bug surfaced during the
  // checks-builtin split: scope-empty checks (e.g. file-length-limit)
  // were scanning every prewarmed file, including paths the user had
  // explicitly listed in `globalExcludes`. The fix threads the run's
  // globalExcludes through RunOptions into the matchFiles fallback.

  function setupCachedFiles(): void {
    mkdirSync(join(testDir, 'src'), { recursive: true })
    mkdirSync(join(testDir, 'docs'), { recursive: true })
    mkdirSync(join(testDir, 'tests', 'fixtures'), { recursive: true })

    writeFileSync(join(testDir, 'src', 'a.ts'), 'export const a = 1')
    writeFileSync(join(testDir, 'docs', 'design.md'), '# Design')
    writeFileSync(join(testDir, 'tests', 'fixtures', 'sample.json'), '{}')
  }

  async function runMatchFiles(globalExcludes?: readonly string[]): Promise<readonly string[]> {
    setupCachedFiles()
    await fileCache.prewarm(testDir, ['**/*.ts', '**/*.md', '**/*.json'])

    const matcher = PathMatcher.create({ cwd: testDir, include: [], exclude: [] })
    const ctx = createExecutionContext(
      { id: 'test-id', slug: 'test-slug', itemType: 'files' },
      testDir,
      matcher,
      globalExcludes ? { globalExcludes } : undefined,
    )
    return ctx.matchFiles()
  }

  it('returns every cached path when no globalExcludes are provided', async () => {
    const files = await runMatchFiles()
    expect(files.length).toBe(3)
    // Sanity: includes the docs and fixtures files that we'll exclude below
    expect(files.some((f) => f.endsWith('docs/design.md'))).toBe(true)
    expect(files.some((f) => f.endsWith('tests/fixtures/sample.json'))).toBe(true)
  })

  it('filters paths matching globalExcludes patterns out of the fallback', async () => {
    const files = await runMatchFiles(['docs/**', 'tests/fixtures/**'])
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/src\/a\.ts$/)
  })

  it('honors extension-style globalExcludes (*.md, *.json)', async () => {
    const files = await runMatchFiles(['**/*.md', '**/*.json'])
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/src\/a\.ts$/)
  })

  it('returns the unfiltered list when globalExcludes is an empty array', async () => {
    // Empty array must not engage the matcher at all — otherwise we
    // pay relative-path computation per file for no reason.
    const files = await runMatchFiles([])
    expect(files.length).toBe(3)
  })
})
