/**
 * Language detection for the `graph` CLI. Scans the project root for
 * known language marker files (tsconfig.json, Cargo.toml, pyproject.toml,
 * etc.) and returns the set of canonical adapter ids that apply. All
 * matched adapters apply simultaneously (polyglot per spec D6).
 *
 * Detection is filtered by the registry — markers whose adapter isn't
 * registered in the current CLI bootstrap are reported in
 * `matchedMarkers` but excluded from `adapterIds`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { logger, type LanguageRegistry } from '@opensip-tools/core'

const MODULE_GRAPH_CLI = 'graph:cli'

/**
 * Marker-file → canonical adapter id. Order matters only for
 * documentation; detection returns ALL matches (polyglot).
 */
const MARKER_MAP: readonly { readonly marker: string; readonly adapterId: string }[] = [
  { marker: 'tsconfig.json', adapterId: 'typescript' },
  { marker: 'package.json', adapterId: 'typescript' },
  { marker: 'Cargo.toml', adapterId: 'rust' },
  { marker: 'pyproject.toml', adapterId: 'python' },
  { marker: 'setup.py', adapterId: 'python' },
  { marker: 'setup.cfg', adapterId: 'python' },
  { marker: 'go.mod', adapterId: 'go' },
  { marker: 'pom.xml', adapterId: 'java' },
  { marker: 'build.gradle', adapterId: 'java' },
  { marker: 'build.gradle.kts', adapterId: 'java' },
  { marker: 'CMakeLists.txt', adapterId: 'cpp' },
  { marker: 'meson.build', adapterId: 'cpp' },
]

export interface DetectionMatch {
  readonly marker: string
  readonly adapterId: string
}

export interface DetectionResult {
  /** Canonical adapter ids of the languages detected at `rootDir`. */
  readonly adapterIds: readonly string[]
  /** Marker files actually found, paired with the adapter they identified. */
  readonly matchedMarkers: readonly DetectionMatch[]
}

/**
 * Scan the project root for known language marker files. Returns ALL
 * matched adapter ids (polyglot supported). Only adapters registered
 * with the given registry are surfaced — if an adapter isn't registered,
 * its markers are still recorded in `matchedMarkers` but filtered from
 * `adapterIds` (defensive against partial CLI bootstrap configurations).
 */
export function detectLanguages(rootDir: string, registry: LanguageRegistry): DetectionResult {
  logger.info({ evt: 'graph.cli.detect.start', module: MODULE_GRAPH_CLI, rootDir })
  const matchedMarkers: DetectionMatch[] = []
  const adapterIdSet = new Set<string>()
  for (const { marker, adapterId } of MARKER_MAP) {
    if (!existsSync(join(rootDir, marker))) continue
    matchedMarkers.push({ marker, adapterId })
    if (registry.get(adapterId) === undefined) continue
    adapterIdSet.add(adapterId)
  }
  const adapterIds = [...adapterIdSet]
  logger.info({
    evt: adapterIds.length > 1 ? 'graph.cli.detect.polyglot' : 'graph.cli.detect.result',
    module: MODULE_GRAPH_CLI,
    adapterIds,
  })
  return { adapterIds, matchedMarkers }
}
