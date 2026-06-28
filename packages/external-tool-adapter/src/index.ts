/**
 * @opensip-cli/external-tool-adapter — substrate for External Tool Adapters.
 *
 * Wrap a user-installed CLI scanner (gitleaks/osv-scanner/trivy/…) as an ordinary
 * opensip-cli `Tool`: `defineExternalToolAdapter(spec)`. The substrate owns binary
 * resolution, the run loop (resolve → execFile → ingest → normalize → persist via
 * the host artifact seam), the shared SARIF/JSON ingest + severity mapping, the
 * `doctor`/`version` commands, secret redaction, and provenance. ADR-0090/0091/0092.
 */

// ── The factory + author surface ────────────────────────────────────────────
export { defineExternalToolAdapter } from './define-external-tool-adapter.js';
export type {
  AdapterProvenance,
  AdapterRunContext,
  BinaryResolutionLayer,
  BinarySpec,
  ExternalCommandSpec,
  ExternalToolAdapterSpec,
  FingerprintStrategyChoice,
  ManifestCommandShell,
  NetworkPosture,
  ParsedScannerOutput,
  ResolvedBinary,
  ScannerExitModel,
  ScannerOutputKind,
} from './types.js';

// ── Ingest + normalization ──────────────────────────────────────────────────
export { ingestSarif } from './ingest-sarif.js';
export type {
  IngestSarifOptions,
  SarifDriver,
  SarifLocation,
  SarifLog,
  SarifMessage,
  SarifPhysicalLocation,
  SarifReportingDescriptor,
  SarifResult,
  SarifRun,
  SarifTool,
} from './ingest-sarif.js';
export { asArray, asObject, getNumber, getString, navigate, safeParseJson } from './ingest-json.js';
export type { JsonParseResult } from './ingest-json.js';
export {
  cvssToSeverity,
  parseCvss,
  sarifLevelToSeverity,
  withNativeSeverity,
} from './severity-map.js';
export type { SarifLevel } from './severity-map.js';

// ── Exit modeling ───────────────────────────────────────────────────────────
export { DEFAULT_EXIT_MODEL, interpretExit } from './exit-model.js';
export type { ExitVerdict } from './exit-model.js';

// ── Binary resolution + provenance + fingerprints ───────────────────────────
export { defaultBinaryEnvVar, resolveBinary } from './binary-resolver.js';
export type { BinaryResolution, BinaryResolveDeps, ResolveBinaryInput } from './binary-resolver.js';
export { messageHashFingerprintStrategy, resolveFingerprintStrategy } from './fingerprint.js';
export { stampProvenance, stampProvenanceAll } from './provenance.js';
export { redactSecret, secretHash } from './redact.js';

// ── Session payload (tool-owned, dashboard-shaped detail) ────────────────────
export { buildAdapterSessionPayload } from './session-payload.js';
export type {
  AdapterFindingSeverity,
  AdapterSessionCheck,
  AdapterSessionFinding,
  AdapterSessionPayload,
} from './session-payload.js';

// ── Artifact path + manifest parity ─────────────────────────────────────────
export { resolveScannerArtifactPath } from './artifact-path.js';
export type { ArtifactPathScope } from './artifact-path.js';
export { deriveAdapterManifestCommands } from './manifest-commands.js';

// ── doctor / version reports ────────────────────────────────────────────────
export { compareVersion } from './doctor-command.js';
export type { AdapterDoctorReport, VersionStatus } from './doctor-command.js';
export type { AdapterVersionReport } from './version-command.js';

// ── Acceptance harness ──────────────────────────────────────────────────────
export { normalizedSignalShape, runAcceptanceCase } from './acceptance-harness.js';
export type { AcceptanceFixture, AcceptanceResult, SignalShape } from './acceptance-harness.js';
