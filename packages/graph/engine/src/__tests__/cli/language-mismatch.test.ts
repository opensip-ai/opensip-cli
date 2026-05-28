/**
 * D14 mixed-mismatch policy tests.
 *
 * When `--language X` is set and the analyzed file count is zero, exit
 * with code 2 and the canonical error message. When at least one file
 * is discovered, the run completes normally. Auto-detection (no
 * `--language`) does NOT trigger the check.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { enterScope, LanguageRegistry } from '@opensip-tools/core'
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { executeGraph } from '../../cli/graph.js'
import { clearAdapterRegistry, registerAdapter } from '../../lang-adapter/registry.js'
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js'

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js'
import type { ToolCliContext } from '@opensip-tools/core'

function emptyAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    // Returns NO files — D14 test: catalog ends up with zero entries.
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [],
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {},
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-empty-v1',
  }
}

function populatedAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {
        fn: [
          {
            bodyHash: 'h1',
            bodySize: 100,
            simpleName: 'fn',
            qualifiedName: 'src/a.fn',
            filePath: 'src/a.ts',
            line: 1,
            column: 0,
            endLine: 5,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'module-local',
            inTestFile: false,
            definedInGenerated: false,
            calls: [],
          },
        ],
      },
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-populated-v1',
  }
}

interface MockCli {
  readonly cli: ToolCliContext
  readonly setExitCode: MockInstance
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn()
  return {
    cli: {
      datastore,
      setExitCode,
      scope: { datastore: () => datastore, languages: new LanguageRegistry() },
    } as unknown as ToolCliContext,
    setExitCode,
  }
}

let stdoutSpy: MockInstance<typeof process.stdout.write>
let stderrSpy: MockInstance<typeof process.stderr.write>
let projectDir: string
let datastore: DataStore

beforeEach(() => {
  enterScope(makeGraphTestScope())
  projectDir = mkdtempSync(join(tmpdir(), 'graph-d14-'))
  datastore = DataStoreFactory.open({ backend: 'memory' })
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  clearAdapterRegistry()
  datastore.close()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  rmSync(projectDir, { recursive: true, force: true })
})

describe('D14 — --language with zero matching files', () => {
  it('exits 2 with the canonical error message', async () => {
    registerAdapter(emptyAdapter(projectDir))
    const { cli, setExitCode } = mockCli(datastore)
    await executeGraph(
      { cwd: projectDir, noCache: true, language: 'typescript' },
      cli,
    )
    expect(setExitCode).toHaveBeenCalledWith(2)
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(err).toContain('--language typescript matched 0 files')
    expect(err).toContain('check the flag or paths')
  })

  it('does NOT trigger when --language is unset (auto-detect path)', async () => {
    registerAdapter(emptyAdapter(projectDir))
    const { cli, setExitCode } = mockCli(datastore)
    await executeGraph(
      { cwd: projectDir, noCache: true },
      cli,
    )
    // Zero files + no --language is a valid (non-error) state.
    expect(setExitCode).toHaveBeenCalledWith(0)
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(err).not.toContain('matched 0 files')
  })

  it('exits 0 when --language is set and ≥1 file matches', async () => {
    registerAdapter(populatedAdapter(projectDir))
    const { cli, setExitCode } = mockCli(datastore)
    await executeGraph(
      { cwd: projectDir, noCache: true, language: 'typescript' },
      cli,
    )
    expect(setExitCode).toHaveBeenCalledWith(0)
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(err).not.toContain('matched 0 files')
  })
})
