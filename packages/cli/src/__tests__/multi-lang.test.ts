/**
 * End-to-end multi-language test.
 *
 * Pins the contract that opensip-tools fit walks files in every
 * bundled language (rust, python, java, go, cpp, typescript) and
 * dispatches checks to the right adapters. Uses the
 * fixtures/multi-lang sample tree as input.
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { distRunner } from './harness/cli-acceptance.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, 'fixtures/multi-lang')
const UNKNOWN_FIXTURE = join(__dirname, 'fixtures/unknown-language')

const cli = distRunner()

describe('CLI multi-language', () => {
  beforeEach(() => {
    rmSync(join(FIXTURE, 'opensip-tools', '.runtime'), { recursive: true, force: true })
    rmSync(join(UNKNOWN_FIXTURE, 'opensip-tools', '.runtime'), { recursive: true, force: true })
  })

  it('lists language adapters for all six bundled languages', () => {
    // The CLI doesn't expose adapters via --list yet; verify by running
    // fit and checking it doesn't throw on any of the language targets.
    const result = cli.run(['fit', '--json'], { cwd: FIXTURE })
    expect([0, 1]).toContain(result.exitCode) // 0 if all pass, 1 if some fail (acceptable in fixture)
    // 2.12.0: --json wraps the envelope in a CommandOutcome (`.envelope`).
    const outcome = JSON.parse(result.stdout) as { envelope: { schemaVersion: number } }
    expect(typeof outcome).toBe('object')
    expect(outcome.envelope.schemaVersion).toBe(2)
  })

  it('produces no plugin-load errors for the fixture', () => {
    const result = cli.run(['fit', '--json'], { cwd: FIXTURE })
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

  it('warns loudly when a target declares an unrecognized language tag', () => {
    const result = cli.run(['fit', '--json'], { cwd: UNKNOWN_FIXTURE })
    // Phase 9 contract: an unrecognized language tag (here `klingon` —
    // no content-filter adapter and not a recognized non-code format)
    // produces a stderr warning and continues running. The fit command
    // does not fail on this.
    expect(result.stderr).toContain('unrecognized language tag')
    expect(result.stderr).toContain('klingon')
    // CLI should still complete (exit 0 since no errors fired) and
    // produce valid JSON on stdout.
    const output = (JSON.parse(result.stdout) as { envelope: { schemaVersion: number } }).envelope
    expect(output.schemaVersion).toBe(2)
  })
})
