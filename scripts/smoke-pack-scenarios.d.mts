/**
 * Type declarations for the packed-smoke scenario list. The runtime lives in
 * `smoke-pack-scenarios.mjs`; like `cli-acceptance-core.d.mts`, this file is
 * the single source of type truth for TS consumers (`allowJs` is off). The
 * PR-lane Vitest suite (`packages/cli/src/__tests__/packed-smoke-scenarios-e2e.test.ts`)
 * imports the SAME scenario list the release lane runs, so the two lanes
 * cannot drift.
 */

import type { Scenario } from './cli-acceptance-core.mjs'

/** Inputs to {@link buildPackedSmokeScenarios} — see the `.mjs` for prose. */
export interface PackedSmokeScenarioOptions {
  /** The consensus release version (no leading 'v'). */
  readonly expectedVersion: string
  /** The throwaway consumer project dir the scenarios run in. */
  readonly consumerCwd: string
  /** Absolute path to the packed `kind:"tool"` fixture tarball. */
  readonly toolPluginTarball: string
  /** Absolute path to the packed `kind:"fit-pack"` fixture tarball. */
  readonly fitPackTarball: string
}

/** Build the ordered packed-smoke scenario list (shared by both CI lanes). */
export function buildPackedSmokeScenarios(opts: PackedSmokeScenarioOptions): Scenario[]
