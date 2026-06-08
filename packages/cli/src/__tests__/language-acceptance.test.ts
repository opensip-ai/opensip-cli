/**
 * Per-language acceptance matrix (Plan A Phase 3).
 *
 * Drives the Phase 2 fixtures (one tiny project per supported language) through
 * the shared CLI acceptance harness against the built `dist/index.js`, asserting
 * per language: `fit --json` runs with no adapter-load error; the language's
 * files are discovered; a known-bad file yields ≥1 finding for the target check
 * while the clean file yields none. The five languages with a graph adapter also
 * assert a well-formed `graph --json` envelope.
 *
 * C++ is fit/language smoke only: there is no graph-cpp adapter, and its only
 * shipped check shells out to clang-tidy (non-hermetic) while the universal
 * no-todo-comments check self-skips paths under `__tests__/` — so the C++ row
 * asserts the adapter loads and `fit` runs, not a specific finding.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, beforeEach } from 'vitest'

import { distRunner, expectEnvelope } from './harness/cli-acceptance.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LANG_DIR = join(__dirname, 'fixtures/languages')
const cli = distRunner()

interface LangRow {
  readonly lang: string
  readonly slug: string
  readonly bad: string
  readonly clean: string
  readonly graph: boolean
}

// Slugs verified to fire from the fixture location (see Phase 2 notes):
// TS uses no-ai-attribution (no-console-log self-skips a /cli/ path allowlist).
const LANGS: readonly LangRow[] = [
  { lang: 'typescript', slug: 'no-ai-attribution', bad: 'bad.ts', clean: 'clean.ts', graph: true },
  { lang: 'python', slug: 'python-no-bare-except', bad: 'bad.py', clean: 'clean.py', graph: true },
  { lang: 'go', slug: 'go-no-fmt-print', bad: 'bad.go', clean: 'clean.go', graph: true },
  { lang: 'java', slug: 'java-no-print-stack-trace', bad: 'Bad.java', clean: 'Clean.java', graph: true },
  { lang: 'rust', slug: 'rust-no-dbg-macro', bad: 'bad.rs', clean: 'clean.rs', graph: true },
  { lang: 'cpp', slug: 'no-todo-comments', bad: 'bad.cpp', clean: 'clean.cpp', graph: false },
]

const ADAPTER_ERROR_MARKERS = ['plugin failed to load', 'failed to load', 'adapter'] as const

function cwdFor(lang: string): string {
  return join(LANG_DIR, lang)
}

beforeEach(() => {
  for (const { lang } of LANGS) {
    rmSync(join(cwdFor(lang), 'opensip-tools', '.runtime'), { recursive: true, force: true })
  }
})

describe.each(LANGS)('language acceptance: $lang', (row) => {
  it('fit --json runs with no adapter-load error', () => {
    const res = cli.run(['fit', '--json'], { cwd: cwdFor(row.lang) })
    expect(res.exitCode, `fit exited ${res.exitCode}; stderr: ${res.stderr}`).toBe(0)
    for (const marker of ['plugin failed to load', 'lang plugin failed to load']) {
      expect(res.stderr).not.toContain(marker)
    }
    const parsed = JSON.parse(res.stdout) as unknown
    expect(expectEnvelope({ tool: 'fit' })(parsed)).toEqual([])
  })

  if (row.lang === 'cpp') {
    // Lang-smoke only — see file header. Prove the C++ adapter discovers .cpp
    // files by running a universal check over them (it executes even though its
    // finding is suppressed under __tests__/), asserting no adapter error.
    it('C++ adapter discovers .cpp files (smoke)', () => {
      const res = cli.run(['fit', '--json'], { cwd: cwdFor('cpp') })
      expect(res.exitCode).toBe(0)
      const parsed = (JSON.parse(res.stdout) as { envelope: { units?: { filesValidated?: number }[] } }).envelope
      const filesSeen = (parsed.units ?? []).reduce((a, u) => a + (u.filesValidated ?? 0), 0)
      expect(filesSeen, 'C++ fixture files should be validated by at least one check').toBeGreaterThan(0)
    })
    return
  }

  it(`bad file fires ${row.slug}; clean file does not`, () => {
    const res = cli.run(['fit', '--json', '--check', row.slug], { cwd: cwdFor(row.lang) })
    expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0)
    const env = (JSON.parse(res.stdout) as {
      envelope: {
        verdict?: { summary?: { total?: number } }
        units?: { slug?: string; violationCount?: number; filesValidated?: number }[]
        signals?: { filePath?: string }[]
      }
    }).envelope
    // The single requested check ran over the discovered fixture files.
    expect(env.verdict?.summary?.total).toBe(1)
    const unit = (env.units ?? []).find((u) => u.slug === row.slug)
    expect(unit, `unit for ${row.slug} should be present`).toBeDefined()
    expect(unit?.filesValidated ?? 0).toBeGreaterThan(0)
    expect(unit?.violationCount ?? 0).toBeGreaterThanOrEqual(1)

    const files = (env.signals ?? []).map((s) => s.filePath ?? '')
    expect(files.some((f) => f.endsWith(row.bad)), `expected a finding on ${row.bad}`).toBe(true)
    expect(files.some((f) => f.endsWith(row.clean)), `clean file ${row.clean} must have no finding`).toBe(false)
  })
})

describe.each(LANGS.filter((l) => l.graph))('graph acceptance: $lang', (row) => {
  it('graph --json yields a well-formed, non-empty envelope', () => {
    const res = cli.run(['graph', '--json'], { cwd: cwdFor(row.lang) })
    expect(res.exitCode, `graph exited ${res.exitCode}; stderr: ${res.stderr}`).toBe(0)
    for (const marker of ADAPTER_ERROR_MARKERS) {
      if (marker === 'adapter') continue // 'adapter' substring is too broad for a hard assert
      expect(res.stderr).not.toContain(marker)
    }
    const outcome = JSON.parse(res.stdout) as { envelope: { units?: unknown; signals?: unknown } }
    expect(expectEnvelope({ tool: 'graph' })(outcome)).toEqual([])
    expect(Array.isArray(outcome.envelope.units)).toBe(true)
  })
})

describe('graph adapter coverage', () => {
  it('C++ has no graph adapter and is excluded from graph acceptance', () => {
    // Guard: if a graph-cpp adapter is ever added, flip cpp.graph and update this.
    const cpp = LANGS.find((l) => l.lang === 'cpp')
    expect(cpp?.graph).toBe(false)
  })
})
