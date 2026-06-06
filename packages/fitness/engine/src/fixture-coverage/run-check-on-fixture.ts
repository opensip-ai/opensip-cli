/**
 * @fileoverview In-process fixture harness for per-check coverage (gap P0).
 *
 * `runCheckOnFixture` writes a fixture case (one file, or a tiny multi-file
 * project) to a temp dir and runs ONE check against it via
 * `Check.run(cwd, { targetFiles })` inside a `RunScope` — the exact mechanism
 * `graph-ignore-hygiene.test.ts` proved — returning only that check's findings
 * (filtered to `fit:<slug>`, since a fixture may incidentally trip other
 * checks). `planCoverageCases` ties the manifest + per-pack allowlist to the
 * co-located `__fixtures__/<slug>/` fixtures on disk, producing the list of
 * clean/violation cases the per-pack meta-test asserts.
 *
 * No vitest here — the per-pack `*.test.ts` owns the assertions.
 */

import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { makeTestScope, withScope } from '@opensip-tools/core/test-utils/with-scope.js'

import { buildFixtureManifest } from './manifest.js'

import type { CheckFixtureRequirement, CoverageConfig } from './manifest.js'
import type { Check } from '../framework/check-types.js'
import type { Signal } from '@opensip-tools/core'

/** One file written into the fixture temp root (path is relative to the root). */
export interface FixtureFile {
  readonly path: string
  readonly content: string
}

/** A fixture case: the files to write, and optionally which to target. */
export interface FixtureCase {
  readonly files: readonly FixtureFile[]
  /** Defaults to every written file; set when a check should see a subset. */
  readonly targetPaths?: readonly string[]
}

/** Result of running one check against one fixture. */
export interface FixtureRun {
  /** Signals whose `ruleId === fit:<slug>` — this check's own findings. */
  readonly findings: readonly Signal[]
  /** Total signals emitted (incl. other checks a multi-file fixture trips). */
  readonly total: number
}

/**
 * Write `fixture` to a fresh temp dir and run `check` against it in-process.
 * Returns only `check`'s own findings. Always cleans up the temp dir.
 */
export async function runCheckOnFixture(check: Check, fixture: FixtureCase): Promise<FixtureRun> {
  const root = await mkdtemp(join(tmpdir(), 'fixcov-'))
  try {
    const written: string[] = []
    for (const file of fixture.files) {
      const abs = join(root, file.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
      written.push(abs)
    }
    const targetFiles = fixture.targetPaths
      ? fixture.targetPaths.map((p) => join(root, p))
      : written
    const result = await withScope(makeTestScope(), () => check.run(root, { targetFiles }))
    const ruleId = `fit:${check.config.slug}`
    return {
      findings: result.signals.filter((s) => s.ruleId === ruleId),
      total: result.signals.length,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export type FixtureVariant = 'clean' | 'violation'

/** A single clean/violation assertion the per-pack meta-test will run. */
export interface CoverageCase {
  readonly slug: string
  readonly variant: FixtureVariant
  readonly check: Check
  /** Loaded fixture, or null when the required fixture is missing on disk. */
  readonly fixture: FixtureCase | null
  /** Stable test label, e.g. `no-todo-comments · clean · txt`. */
  readonly label: string
  /** Actionable message when `fixture` is null. */
  readonly missingHint: string
}

/**
 * Temp filename for a single-file fixture basename. A basename containing a `.`
 * is treated as a full filename (`package.json`, `tsconfig.json`); a bare
 * extension becomes `fixture.<ext>` (passes the extension filter, and the
 * `.<ext>` suffix satisfies `filePath.endsWith()` matchers). Filename-exact
 * checks with no extension (e.g. `Dockerfile`) use a directory fixture instead.
 */
function writeAsFilename(basename: string): string {
  return basename.includes('.') ? basename : `fixture.${basename}`
}

async function readDirFixture(dir: string): Promise<FixtureCase> {
  const files: FixtureFile[] = []
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else files.push({ path: relative(dir, abs), content: await readFile(abs, 'utf8') })
    }
  }
  await walk(dir)
  return { files }
}

/** One walk of `root`, indexing every `__fixtures__/<slug>` directory by slug. */
async function indexFixtureDirs(root: string): Promise<Map<string, string>> {
  const bySlug = new Map<string, string>()
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const abs = join(d, entry.name)
      if (entry.name === '__fixtures__') {
        for (const sub of await readdir(abs, { withFileTypes: true })) {
          if (sub.isDirectory()) bySlug.set(sub.name, join(abs, sub.name))
        }
      } else if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        await walk(abs)
      }
    }
  }
  await walk(root)
  return bySlug
}

async function loadVariant(
  fixtureDir: string | null,
  variant: FixtureVariant,
  basename: string,
): Promise<FixtureCase | null> {
  if (fixtureDir === null) return null
  const variantDir = join(fixtureDir, variant)
  if (existsSync(variantDir) && statSync(variantDir).isDirectory()) {
    return readDirFixture(variantDir)
  }
  const file = join(fixtureDir, `${variant}.${basename}`)
  if (!existsSync(file)) return null
  return { files: [{ path: writeAsFilename(basename), content: await readFile(file, 'utf8') }] }
}

/** Build the clean+violation cases for one requirement (one slug). */
async function casesForRequirement(
  req: CheckFixtureRequirement,
  check: Check,
  dir: string | null,
): Promise<CoverageCase[]> {
  const out: CoverageCase[] = []
  for (const variant of ['clean', 'violation'] as const) {
    // A directory fixture (`<slug>/<variant>/`) covers every basename at once.
    const variantDir = dir ? join(dir, variant) : null
    if (variantDir && existsSync(variantDir) && statSync(variantDir).isDirectory()) {
      out.push({
        slug: req.slug,
        variant,
        check,
        fixture: await readDirFixture(variantDir),
        label: `${req.slug} · ${variant} · <dir>`,
        missingHint: '',
      })
      continue
    }
    for (const basename of req.fixtureBasenames) {
      out.push({
        slug: req.slug,
        variant,
        check,
        fixture: await loadVariant(dir, variant, basename),
        label: `${req.slug} · ${variant} · ${basename}`,
        missingHint:
          `missing ${req.slug}/${variant}.${basename} (or a ${req.slug}/${variant}/ directory) ` +
          `— add the fixture, or allowlist '${req.slug}' with a reason`,
      })
    }
  }
  return out
}

/**
 * Build the clean/violation case list a pack meta-test asserts: one case per
 * (covered slug × variant × required basename), with the fixture loaded from
 * the co-located `__fixtures__/<slug>/` dir (or `null` if missing). Skips
 * command-exempt and allowlisted slugs.
 */
export async function planCoverageCases(
  config: CoverageConfig,
  fixturesRoot: string,
): Promise<CoverageCase[]> {
  const requirements = buildFixtureManifest(config.checks, {
    commandExemptions: config.commandExemptions,
    filenameOverrides: config.filenameOverrides,
  })
  const allow = new Set(config.allowlist)
  const checkBySlug = new Map(config.checks.map((c) => [c.config.slug, c]))
  const dirs = await indexFixtureDirs(fixturesRoot)

  const cases: CoverageCase[] = []
  for (const req of requirements) {
    if (req.domain.kind === 'command-exempt' || allow.has(req.slug)) continue
    const check = checkBySlug.get(req.slug)
    if (!check) continue // unreachable: manifest came from these checks
    cases.push(...(await casesForRequirement(req, check, dirs.get(req.slug) ?? null)))
  }
  return cases
}
