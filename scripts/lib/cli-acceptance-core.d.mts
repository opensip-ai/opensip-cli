/**
 * Type declarations for the dependency-free CLI acceptance harness core.
 * The runtime lives in `cli-acceptance-core.mjs`; this file gives the TS Vitest
 * wrapper (and any TS consumer) real types over it.
 */

export type BinaryDescriptor =
  | { readonly kind: 'node-script'; readonly script: string }
  | { readonly kind: 'installed-bin'; readonly bin: string }

export interface SpawnResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeout?: number
}

export interface ScenarioExpectation {
  readonly exitCode?: number
  readonly exitCodeOneOf?: readonly number[]
  readonly stdoutIncludes?: string
  readonly stdoutExcludes?: string
  readonly stderrIncludes?: string
  /** Predicate over the parsed `--json` stdout; returns failure messages ([] = pass). */
  readonly json?: (parsed: unknown) => string[]
}

export interface ScenarioSetupContext {
  readonly cwd?: string
  readonly descriptor: BinaryDescriptor
  readonly scenario: Scenario
}

export interface Scenario {
  readonly name: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeout?: number
  /** Synchronous pre-spawn hook (e.g. write seed fixtures); throwing fails the scenario. */
  readonly setup?: (ctx: ScenarioSetupContext) => void
  readonly expect: ScenarioExpectation
}

export interface ScenarioResult {
  readonly name: string
  readonly ok: boolean
  readonly failures: string[]
  readonly result: SpawnResult
}

export interface RunScenariosResult {
  readonly passed: number
  readonly failed: number
  readonly results: ScenarioResult[]
}

export function spawnCli(
  descriptor: BinaryDescriptor,
  args: readonly string[],
  opts?: SpawnOptions,
): SpawnResult

export function checkScenario(result: SpawnResult, expect?: ScenarioExpectation): string[]

export function expectEnvelope(opts?: { tool?: string }): (parsed: unknown) => string[]

export function runScenarios(
  descriptor: BinaryDescriptor,
  scenarios: readonly Scenario[],
): RunScenariosResult
