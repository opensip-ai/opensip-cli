/**
 * @fileoverview Shared SARIF result types
 *
 * The producer (`sarif.ts buildSarifRuns`) and the consumer
 * (fitness `gate.ts extractViolationsFromSarif`) used to declare
 * independent `SarifResult` shapes. Consolidating both onto this typed
 * shape removes the `r.ruleId as string` cast in `chunkSarifRuns` and
 * prevents producer/consumer drift.
 *
 * Lives in `@opensip-tools/contracts` (audit 2026-05-29, M1): SARIF is
 * the cross-cutting output-format contract, alongside `CliOutput` and
 * the exit codes. Relocated from fitness so both fitness and graph can
 * report to cloud without a `graph → fitness` import cycle.
 *
 * Only the subset of SARIF 2.1.0 we actually emit/consume is modeled
 * here. The driver section and tool block are typed in `sarif.ts`'s
 * `SarifRun` because they're producer-only.
 */

/** SARIF 2.1.0 region — character offsets within an artifact. */
interface SarifRegion {
  startLine?: number
  startColumn?: number
}

/** SARIF 2.1.0 artifact location — file path within the run. */
interface SarifArtifactLocation {
  uri?: string
}

/** SARIF 2.1.0 physical location — file + region. */
interface SarifPhysicalLocation {
  artifactLocation?: SarifArtifactLocation
  region?: SarifRegion
}

/** SARIF 2.1.0 location entry. We only emit the physicalLocation field. */
export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation
}

/** SARIF 2.1.0 message wrapper around the human-readable text. */
interface SarifMessage {
  text?: string
}

/**
 * SARIF 2.1.0 result. Shared by `buildSarifRuns` (producer) and
 * fitness's `extractViolationsFromSarif` (consumer). All fields are
 * optional because real-world SARIF documents from third-party tools
 * frequently omit fields we don't strictly require.
 *
 * Note: we deliberately do not model `fixes`. The SARIF spec requires
 * `artifactChanges` on every `fix` (§3.55), which fitness has no way
 * to produce from prose suggestions. Suggestion text is folded into
 * `message.text` by the producer instead.
 */
export interface SarifResult {
  ruleId?: string
  level?: string
  message?: SarifMessage
  locations?: readonly SarifLocation[]
}
