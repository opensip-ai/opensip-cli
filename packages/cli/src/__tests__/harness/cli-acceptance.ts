// @fitness-ignore-file test-file-naming -- this is a shared test HELPER (the typed acceptance-harness wrapper imported by the e2e + language-acceptance suites), not a test file; it deliberately is not named *.test.ts.
/**
 * @fileoverview Typed Vitest wrapper over the CLI acceptance harness core.
 *
 * The spawn/assert logic lives in the dependency-free
 * `scripts/cli-acceptance-core.mjs` so the release script
 * (`scripts/smoke-pack.mjs`) and these Vitest suites share identical scenario
 * semantics. This wrapper adds a `CliRunner` bound to a binary descriptor and
 * ergonomic constructors; the e2e suites and the per-language acceptance suite
 * consume it. `smoke-pack.mjs` imports the `.mjs` core directly (no TS).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  expectEnvelope,
  runScenarios,
  spawnCli,
  type BinaryDescriptor,
  type Scenario,
  type ScenarioResult,
  type SpawnOptions,
  type SpawnResult,
} from '../../../../../scripts/cli-acceptance-core.mjs'

// Re-export the core surfaces consumers need directly from the core module
// (export…from, per unicorn/prefer-export-from).
export { checkScenario, expectEnvelope } from '../../../../../scripts/cli-acceptance-core.mjs'
export type {
  BinaryDescriptor,
  Scenario,
  ScenarioExpectation,
  ScenarioResult,
  SpawnOptions,
  SpawnResult,
} from '../../../../../scripts/cli-acceptance-core.mjs'

/** Absolute path to the built CLI entry (this file is at src/__tests__/harness/). */
const DIST_CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url))

/**
 * The CLI package version, read from package.json so `--version` scenarios
 * never drift from source (lifted from e2e.test.ts).
 */
export const CLI_PKG_VERSION: string = (() => {
  const pkgUrl = new URL('../../../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string }
  return pkg.version
})()

/** A binary-bound CLI runner. The binary is a parameter, never hardcoded. */
export class CliRunner {
  constructor(private readonly descriptor: BinaryDescriptor) {}

  /** Run the CLI once; never throws on non-zero exit. */
  run(args: readonly string[], opts: SpawnOptions = {}): SpawnResult {
    return spawnCli(this.descriptor, args, opts)
  }

  /** Run a scenario list against this binary. */
  runScenarios(scenarios: readonly Scenario[]): ScenarioResult[] {
    return runScenarios(this.descriptor, scenarios).results
  }
}

/** Runner against the source-tree build (`packages/cli/dist/index.js`). */
export function distRunner(): CliRunner {
  return new CliRunner({ kind: 'node-script', script: DIST_CLI })
}

/**
 * Predicate for a non-empty graph `--json` catalog: a well-formed graph
 * envelope with at least one signal OR one unit row (the `--json` envelope
 * carries the signal/unit projection, not the raw catalog).
 */
function graphCatalogNonEmpty(parsed: unknown): string[] {
  const failures = expectEnvelope({ tool: 'graph' })(parsed)
  const env = parsed as { signals?: unknown; units?: unknown }
  const signals = Array.isArray(env.signals) ? env.signals : []
  const units = Array.isArray(env.units) ? env.units : []
  if (signals.length === 0 && units.length === 0) {
    failures.push('graph envelope has neither signals nor units (empty catalog)')
  }
  return failures
}

export function expectGraphCatalogNonEmpty(): (parsed: unknown) => string[] {
  return graphCatalogNonEmpty
}
