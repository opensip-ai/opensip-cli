/**
 * Unit tests for the pure `analyzeCommandSurfaceParity` detector behind the
 * `command-surface-parity` check (release 2.11.0 command plane, Principle 6).
 *
 * The detector is a pure `(content) => violations[]` function exercised with no
 * framework, no IO, no mocks — modelled on `cross-tool-flag-parity.ts` /
 * `restrict-raw-db-access.test.ts`. The teeth proof (a raw-Commander cast trips
 * the check) plus the zero-finding proof (the REAL migrated tool.ts files are
 * clean) both live here; the latter reads the actual on-disk tool registration
 * files so the test cannot drift from the tree it guards.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  analyzeCommandSurfaceParity,
  commandSurfaceParity,
  HOST_SUBCOMMAND_GROUP_EXCEPTIONS,
} from '../command-surface-parity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// __tests__ → architecture → checks → src → checks-universal → fitness → packages → repo root
const REPO_ROOT = resolve(HERE, '../../../../../../..')

/** The real migrated tool registration files this check guards. */
const REAL_TOOL_FILES = [
  'packages/fitness/engine/src/tool.ts',
  'packages/graph/engine/src/tool.ts',
  'packages/simulation/engine/src/tool.ts',
]

describe('analyzeCommandSurfaceParity (teeth)', () => {
  it('trips on a `cli.program as CliProgram` cast (the escape 2.11.0 closed)', () => {
    const src = [
      'export function register(cli) {',
      '  const program = cli.program as CliProgram',
      '  program.command("fit").description("Run fitness checks")',
      '}',
    ].join('\n')
    const violations = analyzeCommandSurfaceParity(src)
    // The cast line, the program.command(...) line, and the register()-without-
    // commandSpecs body all trip.
    expect(violations.length).toBeGreaterThanOrEqual(2)
    expect(violations.some((v) => v.message.includes('cli.program as'))).toBe(true)
    expect(violations[0]?.severity).toBe('error')
  })

  it('trips on a raw `program.command(...)` call', () => {
    const v = analyzeCommandSurfaceParity('  const cmd = program.command("graph")')
    expect(v).toHaveLength(1)
    expect(v[0]?.line).toBe(1)
    expect(v[0]?.message).toContain('program.command')
  })

  it('trips on a raw `.option(...)` call in a tool file', () => {
    const v = analyzeCommandSurfaceParity('  cmd.option("--recipe <name>", "Use a recipe")')
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('.option(')
  })

  it('trips on a raw `.argument(...)` / `.requiredOption(...)` call', () => {
    expect(analyzeCommandSurfaceParity('cmd.argument("<name>")')).toHaveLength(1)
    expect(analyzeCommandSurfaceParity('cmd.requiredOption("--out <p>")')).toHaveLength(1)
  })

  it('trips on a `register()` body that declares no `commandSpecs`', () => {
    const src = ['export const fooTool = {', '  register(cli) {', '    doThing(cli)', '  },', '}'].join('\n')
    const v = analyzeCommandSurfaceParity(src)
    expect(v.some((x) => x.message.includes('register()') && x.message.includes('commandSpecs'))).toBe(true)
  })

  it('does NOT trip a `register()` mention when `commandSpecs` is declared (transitional shape)', () => {
    const src = ['export const fooTool = {', '  // legacy register() note', '  commandSpecs: fooSpecs,', '}'].join('\n')
    expect(analyzeCommandSurfaceParity(src)).toEqual([])
  })

  it('is clean on a spec-only tool declaration', () => {
    const src = [
      'export const fooTool: Tool = {',
      '  commands: [FOO],',
      '  commandSpecs: fooCommandSpecs,',
      '  contributeScope,',
      '}',
    ].join('\n')
    expect(analyzeCommandSurfaceParity(src)).toEqual([])
  })
})

describe('command-surface-parity check (metadata + real tree)', () => {
  it('exposes the fresh id + slug (a distinct check, not a re-skin)', () => {
    expect(commandSurfaceParity.config.slug).toBe('command-surface-parity')
    expect(commandSurfaceParity.config.id).toBe('5e84b1fa-1149-4748-8519-848106647306')
  })

  it('reports 0 findings on every REAL migrated tool registration file', () => {
    for (const rel of REAL_TOOL_FILES) {
      const content = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
      const findings = analyzeCommandSurfaceParity(content)
      expect(findings, `${rel} must be raw-Commander-free`).toEqual([])
    }
  })

  it('pins the documented host-command allow-list to exactly sessions + plugin', () => {
    expect([...HOST_SUBCOMMAND_GROUP_EXCEPTIONS]).toEqual(['sessions', 'plugin'])
  })
})
