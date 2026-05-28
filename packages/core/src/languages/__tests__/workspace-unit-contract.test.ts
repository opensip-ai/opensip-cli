import { describe, it, expect, expectTypeOf, vi } from 'vitest'

import type { LanguageAdapter } from '../adapter.js'
import type { WorkspaceUnit } from '../workspace-unit.js'

const FAKE_ROOT = '/var/fixture-root'
const FAKE_PKG_DIR = '/var/fixture-root/packages/a'
const FAKE_PKG_TSCONFIG = '/var/fixture-root/packages/a/tsconfig.json'
const FAKE_SUB_DIR = '/var/fixture-root/sub'

describe('discoverWorkspaceUnits contract', () => {
  it('compiles for an adapter that omits discoverWorkspaceUnits', () => {
    const adapter: LanguageAdapter = {
      id: 'no-workspace',
      fileExtensions: ['.x'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(adapter.discoverWorkspaceUnits).toBeUndefined()
  })

  it('compiles for an adapter that returns an empty unit list', async () => {
    const adapter: LanguageAdapter = {
      id: 'empty-workspace',
      fileExtensions: ['.x'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
      discoverWorkspaceUnits: vi.fn().mockResolvedValue([]),
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(adapter.discoverWorkspaceUnits).toBeTypeOf('function')
    const units = await adapter.discoverWorkspaceUnits?.(FAKE_ROOT)
    expect(units).toEqual([])
  })

  it('compiles for an adapter that returns one WorkspaceUnit', async () => {
    const unit: WorkspaceUnit = {
      id: 'pkg-a',
      rootDir: FAKE_PKG_DIR,
      configPath: FAKE_PKG_TSCONFIG,
    }
    const adapter: LanguageAdapter = {
      id: 'has-workspace',
      fileExtensions: ['.x'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
      // eslint-disable-next-line @typescript-eslint/require-await
      discoverWorkspaceUnits: async () => [unit],
    }
    const units = await adapter.discoverWorkspaceUnits?.(FAKE_ROOT)
    expect(units).toHaveLength(1)
    expect(units?.[0]?.id).toBe('pkg-a')
    expect(units?.[0]?.rootDir).toBe(FAKE_PKG_DIR)
    expect(units?.[0]?.configPath).toBe(FAKE_PKG_TSCONFIG)
  })

  it('makes configPath optional on WorkspaceUnit', () => {
    const unit: WorkspaceUnit = {
      id: 'no-config',
      rootDir: FAKE_SUB_DIR,
    }
    expect(unit.configPath).toBeUndefined()
    expectTypeOf<WorkspaceUnit>().toHaveProperty('id').toEqualTypeOf<string>()
    expectTypeOf<WorkspaceUnit>().toHaveProperty('rootDir').toEqualTypeOf<string>()
  })

  it('typechecks the discoverWorkspaceUnits signature', () => {
    expectTypeOf<NonNullable<LanguageAdapter['discoverWorkspaceUnits']>>().toEqualTypeOf<
      (rootDir: string) => Promise<readonly WorkspaceUnit[]>
    >()
  })
})
