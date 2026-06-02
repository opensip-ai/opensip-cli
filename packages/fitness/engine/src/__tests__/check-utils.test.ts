/**
 * @fileoverview Tests for shared check-utils helpers.
 *
 * Covers display lookups, comment-line detection, and test-file
 * detection — the small surface that check packs share via the
 * engine. These were previously copy-pasted between packs and live
 * in the engine to deduplicate.
 */

import { describe, expect, it } from 'vitest'

import { getCheckIcon, getCheckDisplayName, makeDisplayHelpers } from '../check-utils/display.js'
import { createPathMatcher } from '../check-utils/path-matching.js'
import { isCommentLine } from '../check-utils/source-analysis.js'
import { isTestFile } from '../check-utils/test-helpers.js'

import type { CheckDisplayEntry } from '@opensip-tools/core'

describe('getCheckIcon', () => {
  const map: Record<string, CheckDisplayEntry> = {
    'no-console-log': ['🚫', 'No console.log'],
  }

  it('returns the configured icon when slug is present', () => {
    expect(getCheckIcon(map, 'no-console-log')).toBe('🚫')
  })

  it('falls back to the default magnifying glass when slug is missing', () => {
    expect(getCheckIcon(map, 'unknown-check')).toBe('🔍')
  })

  it('falls back when display map is empty', () => {
    expect(getCheckIcon({}, 'anything')).toBe('🔍')
  })
})

describe('getCheckDisplayName', () => {
  const map: Record<string, CheckDisplayEntry> = {
    'no-console-log': ['🚫', 'No Console Log'],
  }

  it('returns the configured display name', () => {
    expect(getCheckDisplayName(map, 'no-console-log')).toBe('No Console Log')
  })

  it('converts kebab-case slug to Title Case when slug is missing', () => {
    expect(getCheckDisplayName({}, 'no-console-log')).toBe('No Console Log')
  })

  it('handles single-word slugs', () => {
    expect(getCheckDisplayName({}, 'security')).toBe('Security')
  })

  it('handles slugs with multiple hyphens', () => {
    expect(getCheckDisplayName({}, 'a-b-c-d')).toBe('A B C D')
  })

  it('handles empty slug', () => {
    expect(getCheckDisplayName({}, '')).toBe('')
  })
})

describe('makeDisplayHelpers', () => {
  const map: Record<string, CheckDisplayEntry> = {
    'no-console-log': ['🚫', 'No Console Log'],
  }
  const { getCheckIcon: icon, getCheckDisplayName: name } = makeDisplayHelpers(map)

  it('binds the icon lookup to the supplied map', () => {
    expect(icon('no-console-log')).toBe('🚫')
    expect(icon('unknown-check')).toBe('🔍')
  })

  it('binds the display-name lookup to the supplied map', () => {
    expect(name('no-console-log')).toBe('No Console Log')
    expect(name('a-b-c')).toBe('A B C')
  })
})

describe('createPathMatcher', () => {
  it('matches string patterns using includes', () => {
    const stringOnly = createPathMatcher(['/__tests__/'])
    expect(stringOnly('/src/__tests__/foo.ts')).toBe(true)
    expect(stringOnly('/src/main.ts')).toBe(false)
  })

  it('matches RegExp patterns using test', () => {
    const regexOnly = createPathMatcher([/\.test\.ts$/])
    expect(regexOnly('foo.test.ts')).toBe(true)
    expect(regexOnly('foo.ts')).toBe(false)
  })

  it('matches mixed string and RegExp patterns', () => {
    const mixed = createPathMatcher(['/dist/', /node_modules/])
    expect(mixed('/proj/dist/x.js')).toBe(true)
    expect(mixed('/proj/node_modules/lib/index.js')).toBe(true)
    expect(mixed('/proj/src/x.ts')).toBe(false)
  })

  it('returns false for an empty pattern list', () => {
    expect(createPathMatcher([])('/anything')).toBe(false)
  })
})

describe('isCommentLine', () => {
  describe('single-line comments', () => {
    it('detects // comments', () => {
      expect(isCommentLine('// hello')).toBe(true)
    })

    it('detects // comments with leading whitespace', () => {
      expect(isCommentLine('    // indented')).toBe(true)
    })
  })

  describe('block comments', () => {
    it('detects block comment start /* by default', () => {
      expect(isCommentLine('/* start')).toBe(true)
    })

    it('respects includeBlockStart=false', () => {
      expect(isCommentLine('/* start', { includeBlockStart: false })).toBe(false)
    })

    it('detects block continuation lines (* with space)', () => {
      expect(isCommentLine(' * continuation')).toBe(true)
    })

    it('detects block continuation lines (* alone)', () => {
      expect(isCommentLine('*')).toBe(true)
    })

    it('detects block end markers (*/)', () => {
      expect(isCommentLine('*/')).toBe(true)
    })

    it('detects nested * (**)', () => {
      expect(isCommentLine('**')).toBe(true)
    })
  })

  describe('non-comment lines', () => {
    it('rejects regular code', () => {
      expect(isCommentLine('const x = 1;')).toBe(false)
    })

    it('rejects multiplication operator (*=)', () => {
      expect(isCommentLine('x *= 2')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(isCommentLine('')).toBe(false)
    })

    it('rejects whitespace-only line', () => {
      expect(isCommentLine('   ')).toBe(false)
    })
  })
})

describe('isTestFile', () => {
  describe('with default options', () => {
    it('detects __tests__ directory pattern', () => {
      expect(isTestFile('src/__tests__/foo.ts')).toBe(true)
    })

    it('detects .test.ts extension', () => {
      expect(isTestFile('src/foo.test.ts')).toBe(true)
    })

    it('detects .test.tsx extension', () => {
      expect(isTestFile('src/foo.test.tsx')).toBe(true)
    })

    it('detects .spec.ts extension', () => {
      expect(isTestFile('src/foo.spec.ts')).toBe(true)
    })

    it('detects .spec.tsx extension', () => {
      expect(isTestFile('src/foo.spec.tsx')).toBe(true)
    })

    it('rejects production source files', () => {
      expect(isTestFile('src/foo.ts')).toBe(false)
    })

    it('excludes .d.ts declaration files even in __tests__', () => {
      expect(isTestFile('src/__tests__/types.d.ts')).toBe(false)
    })

    it('handles Windows-style path separators', () => {
      expect(isTestFile(String.raw`src\__tests__\foo.ts`)).toBe(true)
    })
  })

  describe('with disabled checks', () => {
    it('does not match __tests__ when checkTestsDir=false', () => {
      expect(isTestFile('src/__tests__/foo.ts', { checkTestsDir: false })).toBe(false)
    })

    it('does not match .test extension when checkTestExtension=false', () => {
      expect(isTestFile('src/foo.test.ts', { checkTestExtension: false })).toBe(false)
    })

    it('does not match .spec extension when checkSpecExtension=false', () => {
      expect(isTestFile('src/foo.spec.ts', { checkSpecExtension: false })).toBe(false)
    })

    it('still matches __tests__ when extension checks are off', () => {
      expect(
        isTestFile('src/__tests__/utils.ts', {
          checkTestExtension: false,
          checkSpecExtension: false,
        }),
      ).toBe(true)
    })

    it('honors excludeDeclarationFiles=false to match .d.ts in test dirs', () => {
      // With excludeDeclarationFiles disabled, the function falls back to
      // pattern matching. A .d.ts inside __tests__ then matches the dir
      // pattern.
      expect(
        isTestFile('src/__tests__/types.d.ts', { excludeDeclarationFiles: false }),
      ).toBe(true)
    })
  })

  describe('with additional patterns', () => {
    it('matches custom regexes via additionalPatterns', () => {
      expect(
        isTestFile('src/foo.fixture.ts', {
          additionalPatterns: [/\.fixture\.tsx?$/],
        }),
      ).toBe(true)
    })

    it('returns false when no patterns match', () => {
      expect(
        isTestFile('src/foo.ts', {
          checkTestsDir: false,
          checkTestExtension: false,
          checkSpecExtension: false,
          additionalPatterns: [/\.fixture\.tsx?$/],
        }),
      ).toBe(false)
    })
  })
})
