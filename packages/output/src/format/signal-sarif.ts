/**
 * @fileoverview signal-sarif formatter — the canonical signal → SARIF v2.1.0
 * emitter (ADR-0011, Phase 2 Task 2.4).
 *
 * Promoted (moved, not copied) from graph's `renderSarifOpenSip`
 * (`graph/engine/src/render/sarif-opensip.ts`), which already walked
 * `Signal[]` directly — the better SARIF builder. The older `CliOutput`-
 * based SARIF path is retired; this is the one SARIF formatter
 * post-migration.
 *
 * Two surfaces:
 *
 * - {@link buildOpenSipSarif} — the moved core builder, `Signal[]` + driver
 *   identity → SARIF string. It emits each signal's `ruleId` **as-is**; the
 *   graph-specific `engine-slug → OpenSIP-rule-ID` mapping stays in graph
 *   (tool vocabulary does not belong in this tool-agnostic layer) and is
 *   applied while graph builds its {@link SignalEnvelope}.
 * - {@link formatSignalSarif} — the canonical {@link Formatter}: reads
 *   `signals`/`tool` off the envelope and derives the driver name
 *   (`opensip-cli-<tool>`). Pure: no IO, no clock, no id generation.
 *
 * Per the prior graph emitter's Phase 0 audit Q1, every finding emits a
 * SINGLE canonical physical location; `relatedLocations` is not populated.
 */
import type { Formatter } from './types.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, SignalSeverity } from '@opensip-cli/core';

/** SARIF v2.1.0 level — `'none' | 'note' | 'warning' | 'error'`. */
type SarifLevel = 'none' | 'note' | 'warning' | 'error';

/**
 * Map `Signal.severity` → SARIF `level`. Exhaustive over
 * `SignalSeverity` (`'critical' | 'high' | 'medium' | 'low'`).
 * `critical` and `high` both surface as `error` to match GitHub Code
 * Scanning's PR-blocking threshold.
 */
function mapSeverityToSarifLevel(severity: SignalSeverity): SarifLevel {
  switch (severity) {
    case 'critical': {
      return 'error';
    }
    case 'high': {
      return 'error';
    }
    case 'medium': {
      return 'warning';
    }
    case 'low': {
      return 'note';
    }
  }
}

/**
 * Coerce a 1-based SARIF region coordinate (startLine / startColumn) to a valid
 * value, returning undefined for anything < 1 or non-finite. SARIF 2.1.0
 * rejects region coordinates below 1; checks that report 0 (meaning "no
 * specific line/column") must be omitted rather than emitted as 0.
 */
function atLeastOne(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : undefined;
}

/** Minimal SARIF v2.1.0 shape — only the fields this emitter populates. */
interface SarifLog {
  readonly $schema: string;
  readonly version: '2.1.0';
  readonly runs: readonly SarifRun[];
}

interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly informationUri?: string;
      readonly rules: readonly SarifReportingDescriptor[];
    };
  };
  readonly properties?: Record<string, unknown>;
  readonly results: readonly SarifResult[];
}

interface SarifReportingDescriptor {
  readonly id: string;
}

interface SarifResult {
  readonly ruleId: string;
  readonly level: SarifLevel;
  readonly message: { readonly text: string };
  readonly locations: readonly SarifLocation[];
  readonly partialFingerprints?: Record<string, string>;
  readonly properties?: Record<string, unknown>;
}

interface SarifLocation {
  readonly physicalLocation: {
    readonly artifactLocation: { readonly uri: string };
    readonly region?: {
      readonly startLine?: number;
      readonly startColumn?: number;
      readonly endLine?: number;
    };
  };
}

/** Driver identity for the emitted SARIF run. */
export interface SarifDriver {
  /** Tool driver name, e.g. `'opensip-cli-graph'`. */
  readonly name: string;
  /** Tool driver version — typically the engine package version. */
  readonly version: string;
}

/**
 * Output-format driver version used when a caller has no real package version
 * to thread (the envelope carries no version field). Tools that want their
 * real engine version in the SARIF provenance pass it via {@link SarifDriver}
 * on {@link buildOpenSipSarif} directly.
 */
const DEFAULT_DRIVER_VERSION = '1.0.0';
const OPEN_SIP_SARIF_RESULT_SCHEMA = 'opensip.signal-result.v1';
const OPEN_SIP_SARIF_RUN_SCHEMA = 'opensip.signal-run.v1';
const MAX_PROPERTY_STRING_LENGTH = 500;
const MAX_PROPERTY_ARRAY_ITEMS = 10;
const MAX_PROPERTY_OBJECT_KEYS = 16;
const MAX_PROPERTY_DEPTH = 3;

const ALLOWLISTED_METADATA_KEYS = new Set([
  'baselineState',
  'originalFingerprint',
  'impact',
  'impactTrust',
  'verification',
  'qualifiedName',
  'simpleName',
  'graphNodeId',
  'blastRadius',
  'yagni',
]);

interface BuildOpenSipSarifOptions {
  readonly runProperties?: Record<string, unknown>;
}

type JsonLike =
  | string
  | number
  | boolean
  | null
  | readonly JsonLike[]
  | { readonly [key: string]: JsonLike };

interface BoundedJson {
  readonly value: JsonLike;
}

function boundedJson(value: unknown, depth = 0): JsonLike | undefined {
  return boundedJsonValue(value, depth)?.value;
}

function boundedJsonValue(value: unknown, depth = 0): BoundedJson | undefined {
  if (value === null) return { value: null };
  if (typeof value === 'string') return { value: value.slice(0, MAX_PROPERTY_STRING_LENGTH) };
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : undefined;
  if (typeof value === 'boolean') return { value };
  if (depth >= MAX_PROPERTY_DEPTH) return undefined;
  if (Array.isArray(value)) return boundedJsonArray(value, depth);
  if (typeof value === 'object') return boundedJsonObject(value, depth);
  return undefined;
}

function boundedJsonArray(value: readonly unknown[], depth: number): BoundedJson | undefined {
  const items = value
    .slice(0, MAX_PROPERTY_ARRAY_ITEMS)
    .map((item) => boundedJsonValue(item, depth + 1))
    .filter((item): item is BoundedJson => item !== undefined)
    .map((item) => item.value);
  return items.length > 0 ? { value: items } : undefined;
}

function boundedJsonObject(value: object, depth: number): BoundedJson | undefined {
  const output: Record<string, JsonLike> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_PROPERTY_OBJECT_KEYS)) {
    const safe = boundedJson(nested, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return Object.keys(output).length > 0 ? { value: output } : undefined;
}

function selectedMetadata(metadata: Record<string, unknown>): Record<string, JsonLike> | undefined {
  const output: Record<string, JsonLike> = {};
  for (const key of ALLOWLISTED_METADATA_KEYS) {
    if (!(key in metadata)) continue;
    const safe = boundedJson(metadata[key]);
    if (safe !== undefined) output[key] = safe;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function resultProperties(signal: Signal): Record<string, unknown> {
  const metadata = selectedMetadata(signal.metadata);
  const repair = signal.repair === undefined ? undefined : boundedJson(signal.repair);
  return {
    openSipSchema: OPEN_SIP_SARIF_RESULT_SCHEMA,
    signalId: signal.id,
    source: signal.source,
    provider: signal.provider,
    category: signal.category,
    ...(signal.fingerprint === undefined ? {} : { fingerprint: signal.fingerprint }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(repair === undefined ? {} : { repair }),
  };
}

function partialFingerprints(signal: Signal): Record<string, string> | undefined {
  return signal.fingerprint === undefined ? undefined : { opensipFingerprint: signal.fingerprint };
}

function runProperties(envelope: SignalEnvelope): Record<string, unknown> {
  return {
    openSipSchema: OPEN_SIP_SARIF_RUN_SCHEMA,
    baselineIdentity: envelope.baselineIdentity,
    ...(envelope.declaredInputs === undefined
      ? {}
      : { declaredInputs: boundedJson(envelope.declaredInputs) }),
    ...(envelope.verification === undefined
      ? {}
      : { verification: boundedJson(envelope.verification) }),
  };
}

/**
 * Build a SARIF v2.1.0 log from `Signal[]` and a driver identity.
 *
 * Each result's `ruleId` is the signal's `ruleId` **verbatim** — any
 * tool-specific rule-ID convention is the caller's responsibility (applied
 * before calling). Every result has exactly one `physicalLocation` (the
 * primary site); transitive context carried in `Signal.metadata` is
 * intentionally dropped at the SARIF boundary.
 */
export function buildOpenSipSarif(
  signals: readonly Signal[],
  driver: SarifDriver,
  options: BuildOpenSipSarifOptions = {},
): string {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();

  for (const signal of signals) {
    ruleIds.add(signal.ruleId);

    const filePath = signal.code?.file ?? signal.filePath;
    // SARIF 2.1.0 requires region.startLine / region.startColumn to be >= 1.
    // Some checks report 0 to mean "no specific line/column" (a whole-file or
    // whole-line finding). Normalize <1 (and non-finite) values to undefined so
    // they are omitted here rather than emitted as invalid 0s — an omitted
    // startColumn denotes the whole line, which is the intended semantics.
    const startLine = atLeastOne(signal.code?.line ?? signal.line);
    const startColumn = atLeastOne(signal.code?.column ?? signal.column);

    const physicalLocation: SarifLocation['physicalLocation'] = {
      artifactLocation: { uri: filePath },
      ...(startLine === undefined
        ? {}
        : {
            region: {
              startLine,
              ...(startColumn !== undefined && { startColumn }),
            },
          }),
    };

    const fingerprints = partialFingerprints(signal);
    results.push({
      ruleId: signal.ruleId,
      level: mapSeverityToSarifLevel(signal.severity),
      message: { text: signal.message },
      locations: [{ physicalLocation }],
      ...(fingerprints === undefined ? {} : { partialFingerprints: fingerprints }),
      properties: resultProperties(signal),
    });
  }

  const sarif: SarifLog = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: driver.name,
            version: driver.version,
            informationUri: 'https://github.com/opensip-ai/opensip-cli',
            rules: [...ruleIds].sort().map((id) => ({ id })),
          },
        },
        ...(options.runProperties === undefined ? {} : { properties: options.runProperties }),
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * The canonical signal → SARIF formatter. Reads `signals`/`tool` off the
 * envelope; the driver name is `opensip-cli-<tool>`. Pure `(envelope) =>
 * string`.
 */
export const formatSignalSarif: Formatter = (envelope) =>
  buildOpenSipSarif(
    envelope.signals,
    {
      name: `opensip-cli-${envelope.tool}`,
      version: DEFAULT_DRIVER_VERSION,
    },
    {
      runProperties: runProperties(envelope),
    },
  );
