import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LanguageRegistry, type LanguageAdapter } from '@opensip-tools/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectLanguages } from '../../cli/detect.js'

function makeAdapter(id: string, fileExtensions: readonly string[] = ['.x']): LanguageAdapter {
  return {
    id,
    fileExtensions,
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
  }
}

function makeFullRegistry(): LanguageRegistry {
  const r = new LanguageRegistry()
  r.register(makeAdapter('typescript', ['.ts']))
  r.register(makeAdapter('rust', ['.rs']))
  r.register(makeAdapter('python', ['.py']))
  r.register(makeAdapter('go', ['.go']))
  r.register(makeAdapter('java', ['.java']))
  r.register(makeAdapter('cpp', ['.cpp']))
  return r
}

describe('detectLanguages', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'osip-detect-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns empty results for an empty directory', () => {
    const r = makeFullRegistry()
    const result = detectLanguages(root, r)
    expect(result.adapterIds).toEqual([])
    expect(result.matchedMarkers).toEqual([])
  })

  it('detects typescript from tsconfig.json', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    const result = detectLanguages(root, makeFullRegistry())
    expect(result.adapterIds).toEqual(['typescript'])
    expect(result.matchedMarkers).toEqual([{ marker: 'tsconfig.json', adapterId: 'typescript' }])
  })

  it('detects rust from Cargo.toml', () => {
    writeFileSync(join(root, 'Cargo.toml'), '')
    const result = detectLanguages(root, makeFullRegistry())
    expect(result.adapterIds).toEqual(['rust'])
  })

  it('returns both adapter ids for a polyglot repo (tsconfig + Cargo)', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'Cargo.toml'), '')
    const result = detectLanguages(root, makeFullRegistry())
    expect(result.adapterIds).toEqual(['typescript', 'rust'])
    expect(result.matchedMarkers).toHaveLength(2)
  })

  it('dedupes adapter ids when multiple markers point at the same adapter', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'package.json'), '{}')
    const result = detectLanguages(root, makeFullRegistry())
    expect(result.adapterIds).toEqual(['typescript'])
    expect(result.matchedMarkers).toHaveLength(2)
  })

  it('filters out adapters not registered in the current registry', () => {
    writeFileSync(join(root, 'pyproject.toml'), '')
    const r = new LanguageRegistry()
    r.register(makeAdapter('typescript', ['.ts']))
    // python not registered
    const result = detectLanguages(root, r)
    expect(result.adapterIds).toEqual([])
    // marker still recorded for diagnostic purposes
    expect(result.matchedMarkers).toEqual([{ marker: 'pyproject.toml', adapterId: 'python' }])
  })

  it('detects all six languages when all markers are present and registered', () => {
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'Cargo.toml'), '')
    writeFileSync(join(root, 'pyproject.toml'), '')
    writeFileSync(join(root, 'go.mod'), '')
    writeFileSync(join(root, 'pom.xml'), '')
    writeFileSync(join(root, 'CMakeLists.txt'), '')
    const result = detectLanguages(root, makeFullRegistry())
    expect([...result.adapterIds].sort()).toEqual(
      ['cpp', 'go', 'java', 'python', 'rust', 'typescript'].sort(),
    )
  })
})
