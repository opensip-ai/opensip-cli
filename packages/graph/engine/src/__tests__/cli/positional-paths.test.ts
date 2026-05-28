/**
 * Tests for resolvePositionalPaths — happy paths and error branches.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { ConfigurationError } from '@opensip-tools/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { positionalPathLabel, resolvePositionalPaths } from '../../cli/positional-paths.js'

describe('resolvePositionalPaths', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'osip-pos-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('returns [] for an empty array', () => {
    expect(resolvePositionalPaths([], cwd)).toEqual([])
  })

  it('resolves a relative path against cwd', () => {
    mkdirSync(join(cwd, 'sub'))
    const result = resolvePositionalPaths(['sub'], cwd)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(resolve(cwd, 'sub'))
    expect(isAbsolute(result[0] ?? '')).toBe(true)
  })

  it('passes through an absolute path', () => {
    const abs = join(cwd, 'sub')
    mkdirSync(abs)
    const result = resolvePositionalPaths([abs], cwd)
    expect(result).toEqual([abs])
  })

  it('trims leading/trailing whitespace before resolution', () => {
    mkdirSync(join(cwd, 'sub'))
    const result = resolvePositionalPaths(['  sub  '], cwd)
    expect(result[0]).toBe(resolve(cwd, 'sub'))
  })

  it('throws ConfigurationError on an empty string', () => {
    expect(() => resolvePositionalPaths(['   '], cwd)).toThrow(ConfigurationError)
    expect(() => resolvePositionalPaths(['   '], cwd)).toThrow(/empty/)
  })

  it('throws on a non-existent path and reports the original arg', () => {
    let caught: unknown
    try {
      resolvePositionalPaths(['nope'], cwd)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigurationError)
    expect((caught as Error).message).toContain('nope')
    expect((caught as Error).message).toContain('does not exist')
  })

  it('throws when the path is a file, not a directory', () => {
    writeFileSync(join(cwd, 'file.txt'), 'hi')
    expect(() => resolvePositionalPaths(['file.txt'], cwd)).toThrow(ConfigurationError)
    expect(() => resolvePositionalPaths(['file.txt'], cwd)).toThrow(/not a directory/)
  })

  it('preserves argument order in the output', () => {
    mkdirSync(join(cwd, 'a'))
    mkdirSync(join(cwd, 'b'))
    const result = resolvePositionalPaths(['b', 'a'], cwd)
    expect(result.map((p) => p.split('/').pop())).toEqual(['b', 'a'])
  })
})

describe('positionalPathLabel', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'osip-pos-label-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('returns "." when the path equals cwd', () => {
    expect(positionalPathLabel(cwd, cwd)).toBe('.')
  })

  it('returns a relative label when the path is under cwd', () => {
    const sub = join(cwd, 'a', 'b')
    expect(positionalPathLabel(sub, cwd)).toBe('a/b')
  })

  it('returns the absolute path when not under cwd', () => {
    const other = '/some/totally/different/path'
    expect(positionalPathLabel(other, cwd)).toBe(other)
  })
})
