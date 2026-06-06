/**
 * @fileoverview Per-check fixture-coverage manifest (testing gap P0).
 *
 * Turns the runtime list of *shipped* checks (each pack's exported `checks`
 * array) into a list of **fixture requirements**: for every non-disabled,
 * non-command check, which clean/violation fixtures must exist and under what
 * filenames. The manifest is the authoritative source for the per-pack
 * coverage meta-tests; it reads the runtime `Check` objects (not re-parsed
 * source like `scripts/extract-checks-metadata.mjs`), so it sees
 * `config.{slug,checkScope,fileTypes,analysisMode,disabled}` directly.
 *
 * Pure: no file I/O, no vitest. The per-pack `*.test.ts` files own the Vitest
 * assertions (keeping the engine's published `./internal` surface vitest-free,
 * matching the `with-scope.ts` test-util precedent). The fs harness that
 * actually exercises a fixture lives in `./run-check-on-fixture.ts`.
 */

import type { Check, CheckConfig } from '../framework/check-types.js'

/** Maps a check's declared language to its fixture file extension. */
export const LANGUAGE_EXTENSION: Readonly<Record<string, string>> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  go: 'go',
  java: 'java',
  rust: 'rs',
  cpp: 'cpp',
}

/**
 * Extension for a declared language. Falls back to the language string itself
 * (a deliberately visible default — an unmapped language yields e.g.
 * `clean.kotlin`, which is obviously wrong and prompts a map entry).
 */
export function extForLanguage(language: string): string {
  return LANGUAGE_EXTENSION[language] ?? language
}

/** What kind of fixtures a check needs, derived from its config. */
export type FixtureDomain =
  | { readonly kind: 'language'; readonly languages: readonly string[] }
  | { readonly kind: 'universal' }
  | { readonly kind: 'file-typed'; readonly fileTypes: readonly string[] }
  | { readonly kind: 'command-exempt'; readonly reason: string }

/** A single shipped check's fixture requirement. */
export interface CheckFixtureRequirement {
  readonly slug: string
  readonly domain: FixtureDomain
  /**
   * Single-file fixture suffixes: the harness writes `${variant}.${suffix}`
   * (e.g. `clean.ts`, `violation.package.json`). Empty for command-exempt
   * checks. A check that needs sibling files uses a `clean/` / `violation/`
   * directory instead (resolved at load time), independent of these.
   */
  readonly fixtureBasenames: readonly string[]
}

/** Per-pack list of slugs not yet covered; must shrink to []. */
export type CoverageAllowlist = readonly string[]
/** Per-pack command-mode exemptions: slug → justification. */
export type CommandExemptions = Readonly<Record<string, string>>
/** Per-pack per-slug fixture filename override (e.g. 'package.json', 'Dockerfile'). */
export type FilenameOverrides = Readonly<Record<string, string>>

/** Inputs to {@link buildFixtureManifest}. */
export interface BuildManifestOptions {
  readonly commandExemptions: CommandExemptions
  readonly filenameOverrides?: FilenameOverrides
}

function stripLeadingDot(s: string): string {
  return s.startsWith('.') ? s.slice(1) : s
}

function basenamesFor(
  config: CheckConfig,
  domain: FixtureDomain,
  overrides: FilenameOverrides | undefined,
): readonly string[] {
  const override = overrides?.[config.slug]
  if (override !== undefined) return [override]
  switch (domain.kind) {
    case 'language': {
      return [...new Set(domain.languages.map(extForLanguage))]
    }
    case 'file-typed': {
      return [...new Set(domain.fileTypes.map(stripLeadingDot))]
    }
    case 'universal': {
      return ['txt']
    }
    case 'command-exempt': {
      return []
    }
  }
}

/**
 * Build the fixture-requirement list from a pack's shipped `checks`.
 *
 * Disabled checks are skipped (they don't ship). Command-mode checks become
 * `command-exempt` and MUST carry a reason in `commandExemptions` — a missing
 * reason throws, so a new command check can't silently escape coverage.
 */
export function buildFixtureManifest(
  checks: readonly Check[],
  opts: BuildManifestOptions,
): CheckFixtureRequirement[] {
  const requirements: CheckFixtureRequirement[] = []
  for (const check of checks) {
    const config = check.config
    if (config.disabled === true) continue

    let domain: FixtureDomain
    if (config.analysisMode === 'command') {
      const reason = opts.commandExemptions[config.slug]
      if (reason === undefined || reason.length === 0) {
        throw new Error(
          `command-mode check '${config.slug}' has no exemption reason; add it to COMMAND_EXEMPTIONS`,
        )
      }
      domain = { kind: 'command-exempt', reason }
    } else if (config.checkScope?.languages && config.checkScope.languages.length > 0) {
      domain = { kind: 'language', languages: config.checkScope.languages }
    } else if (config.fileTypes && config.fileTypes.length > 0) {
      domain = { kind: 'file-typed', fileTypes: config.fileTypes }
    } else {
      domain = { kind: 'universal' }
    }

    requirements.push({
      slug: config.slug,
      domain,
      fixtureBasenames: basenamesFor(config, domain, opts.filenameOverrides),
    })
  }
  return requirements
}

/** A pack's coverage configuration, shared by bookkeeping + case planning. */
export interface CoverageConfig {
  readonly packName: string
  readonly checks: readonly Check[]
  readonly allowlist: CoverageAllowlist
  readonly commandExemptions: CommandExemptions
  readonly filenameOverrides?: FilenameOverrides
  /**
   * When `false`/absent (the post-migration default), a non-empty allowlist is
   * a bookkeeping problem — the contributor ratchet. Set `true` only to waive a
   * check with PR-description justification (mirrors `disabledChecks` policy).
   */
  readonly allowNonEmptyAllowlist?: boolean
}

function allowlistProblems(config: CoverageConfig, shipped: ReadonlyMap<string, CheckConfig>): string[] {
  const problems: string[] = []
  for (const slug of config.allowlist) {
    if (!shipped.has(slug)) {
      problems.push(`allowlist names '${slug}', which no longer ships — remove it`)
    }
    if (slug in config.commandExemptions) {
      problems.push(`'${slug}' is in BOTH allowlist and commandExemptions — pick one`)
    }
  }
  if (config.allowNonEmptyAllowlist !== true && config.allowlist.length > 0) {
    problems.push(
      `allowlist is non-empty (${String(config.allowlist.length)} slug(s)) — every shipped check must have clean+violation fixtures. ` +
        `Add the fixtures, or set allowNonEmptyAllowlist:true with PR justification.`,
    )
  }
  return problems
}

function exemptionProblems(config: CoverageConfig, shipped: ReadonlyMap<string, CheckConfig>): string[] {
  const problems: string[] = []
  for (const slug of Object.keys(config.commandExemptions)) {
    const cfg = shipped.get(slug)
    if (!cfg) {
      problems.push(`commandExemptions names '${slug}', which no longer ships — remove it`)
    } else if (cfg.disabled !== true && cfg.analysisMode !== 'command') {
      problems.push(`commandExemptions names '${slug}' but it is not analysisMode:'command'`)
    }
  }
  for (const check of config.checks) {
    const cfg = check.config
    if (cfg.disabled !== true && cfg.analysisMode === 'command' && !(cfg.slug in config.commandExemptions)) {
      problems.push(
        `command-mode check '${cfg.slug}' is not in commandExemptions (it cannot be fixture-exercised)`,
      )
    }
  }
  return problems
}

function manifestProblems(config: CoverageConfig): string[] {
  try {
    buildFixtureManifest(config.checks, {
      commandExemptions: config.commandExemptions,
      filenameOverrides: config.filenameOverrides,
    })
    return []
  } catch (error) {
    return [`manifest build failed: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/**
 * Self-consistency guards over a pack's coverage config — pure, returns a list
 * of human-readable problems (empty = healthy). The per-pack meta-test asserts
 * this is `[]`. Covers: stale allowlist entries, the closed command-exemption
 * set, no double-listing, the empty-allowlist ratchet, and that the manifest
 * builds.
 */
export function validateBookkeeping(config: CoverageConfig): string[] {
  const shipped = new Map<string, CheckConfig>()
  for (const check of config.checks) shipped.set(check.config.slug, check.config)
  return [
    ...allowlistProblems(config, shipped),
    ...exemptionProblems(config, shipped),
    ...manifestProblems(config),
  ]
}
