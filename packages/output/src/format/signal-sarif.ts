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
 *   (`opensip-tools-<tool>`). Pure: no IO, no clock, no id generation.
 *
 * Per the prior graph emitter's Phase 0 audit Q1, every finding emits a
 * SINGLE canonical physical location; `relatedLocations` is not populated.
 */
import type { Formatter } from './types.js';
import type { Signal, SignalSeverity } from '@opensip-tools/core';

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
  /** Tool driver name, e.g. `'opensip-tools-graph'`. */
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
const DEFAULT_DRIVER_VERSION = '2.0.0';

/**
 * Build a SARIF v2.1.0 log from `Signal[]` and a driver identity.
 *
 * Each result's `ruleId` is the signal's `ruleId` **verbatim** — any
 * tool-specific rule-ID convention is the caller's responsibility (applied
 * before calling). Every result has exactly one `physicalLocation` (the
 * primary site); transitive context carried in `Signal.metadata` is
 * intentionally dropped at the SARIF boundary.
 */
export function buildOpenSipSarif(signals: readonly Signal[], driver: SarifDriver): string {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();

  for (const signal of signals) {
    ruleIds.add(signal.ruleId);

    const filePath = signal.code?.file ?? signal.filePath;
    const startLine = signal.code?.line ?? signal.line;
    const startColumn = signal.code?.column ?? signal.column;

    const physicalLocation: SarifLocation['physicalLocation'] = {
      artifactLocation: { uri: filePath },
      ...(startLine !== undefined || startColumn !== undefined
        ? {
            region: {
              ...(startLine !== undefined && { startLine }),
              ...(startColumn !== undefined && { startColumn }),
            },
          }
        : {}),
    };

    results.push({
      ruleId: signal.ruleId,
      level: mapSeverityToSarifLevel(signal.severity),
      message: { text: signal.message },
      locations: [{ physicalLocation }],
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
            informationUri: 'https://github.com/opensip-ai/opensip-tools',
            rules: [...ruleIds].sort().map((id) => ({ id })),
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * The canonical signal → SARIF formatter. Reads `signals`/`tool` off the
 * envelope; the driver name is `opensip-tools-<tool>`. Pure `(envelope) =>
 * string`.
 */
export const formatSignalSarif: Formatter = (envelope) =>
  buildOpenSipSarif(envelope.signals, {
    name: `opensip-tools-${envelope.tool}`,
    version: DEFAULT_DRIVER_VERSION,
  });
