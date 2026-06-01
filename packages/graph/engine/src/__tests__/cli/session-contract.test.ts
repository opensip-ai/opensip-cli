/**
 * D12: one CLI invocation = one session.
 *
 * Regression test asserting that every dispatch branch of executeGraph
 * either writes exactly one session or zero (for opt-out modes). The
 * commit 2ed25d3 contract must not regress.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { enterScope, LanguageRegistry } from '@opensip-tools/core'
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore'
import { SessionRepo } from '@opensip-tools/session-store'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { executeGraph } from '../../cli/graph.js'
import { currentAdapterRegistry } from '../../lang-adapter/registry.js'
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js'

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js'
import type { GraphSessionPayload } from '../../persistence/session-payload.js'
import type { LanguageAdapter, ToolCliContext, WorkspaceUnit } from '@opensip-tools/core'

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
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
    cacheKey: () => 'fake-v1',
  }
}

function mockCli(datastore: DataStore, languages?: LanguageRegistry): ToolCliContext {
  return {
    datastore,
    setExitCode: vi.fn(),
    render: () => Promise.resolve(),
    scope: {
      datastore: () => datastore,
      languages: languages ?? new LanguageRegistry(),
    },
  } as unknown as ToolCliContext
}

function workspaceLangRegistry(units: readonly WorkspaceUnit[]): LanguageRegistry {
  const r = new LanguageRegistry()
  const adapter: LanguageAdapter = {
    id: 'typescript',
    fileExtensions: ['.ts'],
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
    // eslint-disable-next-line @typescript-eslint/require-await
    discoverWorkspaceUnits: async () => units,
  }
  r.register(adapter)
  return r
}

function countSessions(datastore: DataStore): number {
  return new SessionRepo(datastore).count()
}

let stdoutSpy: MockInstance<typeof process.stdout.write>
let stderrSpy: MockInstance<typeof process.stderr.write>
let projectDir: string
let datastore: DataStore

beforeEach(() => {
  enterScope(makeGraphTestScope())
  projectDir = mkdtempSync(join(tmpdir(), 'graph-session-'))
  datastore = DataStoreFactory.open({ backend: 'memory' })
  currentAdapterRegistry().register(fakeAdapter(projectDir))
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  currentAdapterRegistry().clear()
  datastore.close()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  rmSync(projectDir, { recursive: true, force: true })
})

describe('D12 — one CLI invocation = one session', () => {
  it('default run writes exactly one session', async () => {
    await executeGraph({ cwd: projectDir, noCache: true }, mockCli(datastore))
    expect(countSessions(datastore)).toBe(1)
  })

  it('single positional path writes exactly one session', async () => {
    mkdirSync(join(projectDir, 'sub'))
    await executeGraph(
      { cwd: projectDir, noCache: true, paths: [join(projectDir, 'sub')] },
      mockCli(datastore),
    )
    expect(countSessions(datastore)).toBe(1)
  })

  it('multiple positional paths write exactly one aggregate session', async () => {
    mkdirSync(join(projectDir, 'a'))
    mkdirSync(join(projectDir, 'b'))
    await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        paths: [join(projectDir, 'a'), join(projectDir, 'b')],
      },
      mockCli(datastore),
    )
    expect(countSessions(datastore)).toBe(1)
  })

  it('--workspace writes exactly one aggregate session (not one per unit)', async () => {
    const pkgA = join(projectDir, 'packages', 'a')
    mkdirSync(pkgA, { recursive: true })
    writeFileSync(join(pkgA, 'tsconfig.json'), '{}')
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}')
    const fakeCliPath = join(projectDir, 'fake.cjs')
    writeFileSync(
      fakeCliPath,
      `process.stdout.write(JSON.stringify({version:'1.0',tool:'graph',timestamp:new Date().toISOString(),recipe:'graph',score:100,passed:true,summary:{total:0,passed:0,failed:0,errors:0,warnings:0},checks:[],durationMs:0}));process.exit(0);`,
    )
    const units: WorkspaceUnit[] = [
      { id: 'a', rootDir: pkgA, configPath: join(pkgA, 'tsconfig.json') },
    ]
    await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        workspace: true,
        cliScript: fakeCliPath,
        concurrency: 1,
      },
      mockCli(datastore, workspaceLangRegistry(units)),
    )
    expect(countSessions(datastore)).toBe(1)
  })

  it('--json opts out of session persistence', async () => {
    await executeGraph(
      { cwd: projectDir, noCache: true, json: true },
      mockCli(datastore),
    )
    expect(countSessions(datastore)).toBe(0)
  })

  it('--gate-save opts out of session persistence', async () => {
    await executeGraph(
      { cwd: projectDir, noCache: true, gateSave: true },
      mockCli(datastore),
    )
    expect(countSessions(datastore)).toBe(0)
  })

  it('--report-to opts out of session persistence (even on failure)', async () => {
    await executeGraph(
      { cwd: projectDir, noCache: true, reportTo: 'http://127.0.0.1:1' },
      mockCli(datastore),
    )
    expect(countSessions(datastore)).toBe(0)
  })
})

describe('graph session payload — rule-grouped detail is persisted', () => {
  it('default run writes a payload with summary + checks (not summary-only)', async () => {
    await executeGraph({ cwd: projectDir, noCache: true }, mockCli(datastore))

    const session = new SessionRepo(datastore).latest()
    expect(session).not.toBeNull()

    const payload = session?.payload as GraphSessionPayload | undefined
    expect(payload).toBeDefined()

    // The native signal summary is carried verbatim from the run's CliOutput.
    expect(payload?.summary).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        passed: expect.any(Number),
        failed: expect.any(Number),
        errors: expect.any(Number),
        warnings: expect.any(Number),
      }),
    )

    // The rule-grouped detail (`checks`) is what the Code Paths → Sessions
    // panel renders, and the reason the payload is no longer summary-only.
    // A regression to `{ summary }` (the pre-extension shape) drops this key —
    // session count stays 1, so only this assertion catches it.
    expect(payload).toHaveProperty('checks')
    expect(Array.isArray(payload?.checks)).toBe(true)
  })
})
