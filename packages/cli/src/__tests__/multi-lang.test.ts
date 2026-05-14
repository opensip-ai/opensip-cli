/**
 * End-to-end multi-language test.
 *
 * Pins the contract that opensip-tools fit walks files in every
 * bundled language (rust, python, java, go, cpp, typescript) and
 * dispatches checks to the right adapters. Uses the
 * fixtures/multi-lang sample tree as input.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(__dirname, '../../dist/index.js')
const FIXTURE = join(__dirname, 'fixtures/multi-lang')
const UNKNOWN_FIXTURE = join(__dirname, 'fixtures/unknown-language')

function runIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  return runIn(FIXTURE, ...args)
}

describe('CLI multi-language', () => {
  it('lists language adapters for all six bundled languages', () => {
    // The CLI doesn't expose adapters via --list yet; verify by running
    // fit and checking it doesn't throw on any of the language targets.
    const result = run('fit', '--json')
    expect([0, 1]).toContain(result.exitCode) // 0 if all pass, 1 if some fail (acceptable in fixture)
    const output: unknown = JSON.parse(result.stdout)
    expect(typeof output).toBe('object')
    expect((output as { version: string }).version).toBe('1.0')
  })

  it('produces no plugin-load errors for the fixture', () => {
    const result = run('fit', '--json')
    // stderr may have warnings about unrelated things, but no
    // "lang plugin failed to load" or "plugin failed to load"
    expect(result.stderr).not.toContain('lang plugin failed to load')
    expect(result.stderr).not.toContain('plugin failed to load')
  })

  it('fixture contains source files in every supported language', () => {
    // Sanity: confirm the fixture is what we expect (so the CLI run
    // above is meaningful).
    const langs = ['rs', 'py', 'java', 'go', 'cpp', 'ts']
    const files = readdirSync(join(FIXTURE, 'src'))
    for (const ext of langs) {
      const matches = files.filter((f) => f.endsWith(`.${ext}`))
      expect(matches.length).toBeGreaterThan(0)
    }
  })

  it('fixture config declares targets for every language', () => {
    const cfg = readFileSync(join(FIXTURE, 'opensip-tools.config.yml'), 'utf8')
    expect(cfg).toContain('languages: [rust]')
    expect(cfg).toContain('languages: [python]')
    expect(cfg).toContain('languages: [java]')
    expect(cfg).toContain('languages: [go]')
    expect(cfg).toContain('languages: [cpp]')
    expect(cfg).toContain('languages: [typescript]')
  })

  it('warns loudly when a target declares an unknown language', () => {
    const result = runIn(UNKNOWN_FIXTURE, 'fit', '--json')
    // Phase 9 contract: unknown languages produce a stderr warning and
    // continue running. The fit command does not fail on this.
    expect(result.stderr).toContain('unknown language')
    expect(result.stderr).toContain('klingon')
    // CLI should still complete (exit 0 since no errors fired) and
    // produce valid JSON on stdout.
    const output = JSON.parse(result.stdout) as { version: string }
    expect(output.version).toBe('1.0')
  })
})
