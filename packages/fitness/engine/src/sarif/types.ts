/**
 * @fileoverview Shared SARIF result types
 *
 * The producer (`sarif.ts buildSarifRuns`) and the consumer
 * (`gate.ts extractViolationsFromSarif`) used to declare independent
 * `SarifResult` shapes — one with a `Record<string, unknown>` value
 * carrying a stringly-typed `ruleId`, the other with structured optional
 * fields. Consolidating both onto this typed shape removes the
 * `r.ruleId as string` cast in `chunkSarifRuns` and prevents producer/
 * consumer drift (e.g. a new optional field added to one but not the
 * other).
 *
 * Only the subset of SARIF 2.1.0 we actually emit/consume is modeled
 * here. The driver section and tool block are typed in `sarif.ts`'s
 * `SarifRun` because they're producer-only.
 */

/** SARIF 2.1.0 region — character offsets within an artifact. */
export interface SarifRegion {
  startLine?: number
  startColumn?: number
}

/** SARIF 2.1.0 artifact location — file path within the run. */
export interface SarifArtifactLocation {
  uri?: string
}

/** SARIF 2.1.0 physical location — file + region. */
export interface SarifPhysicalLocation {
  artifactLocation?: SarifArtifactLocation
  region?: SarifRegion
}

/** SARIF 2.1.0 location entry. We only emit the physicalLocation field. */
export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation
}

/** SARIF 2.1.0 message wrapper around the human-readable text. */
export interface SarifMessage {
  text?: string
}

/** SARIF 2.1.0 fix description. */
export interface SarifFix {
  description?: SarifMessage
}

/**
 * SARIF 2.1.0 result. Shared by `buildSarifRuns` (producer) and
 * `extractViolationsFromSarif` (consumer) in gate.ts. All fields are
 * optional because real-world SARIF documents from third-party tools
 * frequently omit fields we don't strictly require.
 */
export interface SarifResult {
  ruleId?: string
  level?: string
  message?: SarifMessage
  locations?: readonly SarifLocation[]
  fixes?: readonly SarifFix[]
}
