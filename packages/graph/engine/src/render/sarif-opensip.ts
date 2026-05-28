/**
 * @fileoverview Graph-native SARIF v2.1.0 emitter with OpenSIP rule-ID convention.
 *
 * Replaces the prior fitness-shim wrapper (`@opensip-tools/fitness`'s
 * `buildSarifLog`) that funneled findings through the `CliOutput` shape.
 * This emitter walks `Signal[]` directly and produces SARIF results
 * whose `ruleId` follows the `graph.<rule-family>.<rule-id>` convention
 * required by OpenSIP's `SarifProvider` for downstream signal ingestion.
 *
 * Per Phase 0 audit Q1 (no consumer demand for multi-location data on
 * the OpenSIP side), every finding emits a SINGLE canonical physical
 * location. `relatedLocations` is deliberately not populated even for
 * blast-radius rules whose `Signal.metadata` may carry transitive-
 * context data — that data lives on the engine side for future
 * analysis but is intentionally dropped at the SARIF boundary.
 *
 * Phase 2 Task 2.2 per DEC-498.
 */

import { mapEngineSlugToOpenSipRuleId } from './rule-id-mapping.js';

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

/** Required context — caller (`cli/graph.ts`) provides tool identity. */
interface RenderSarifContext {
  /** Tool driver name, e.g. `'opensip-tools-graph'`. */
  readonly tool: string;
  /** Tool driver version — typically the engine package version. */
  readonly toolVersion: string;
}

/**
 * Build a SARIF v2.1.0 log from engine `Signal[]` output.
 *
 * Every result's `ruleId` is the OpenSIP-convention slug from
 * `mapEngineSlugToOpenSipRuleId`. Every result has exactly one
 * `physicalLocation` (the primary site); transitive context that the
 * engine may carry in `Signal.metadata` is intentionally dropped per
 * Phase 0 audit Q1.
 *
 * @throws {ValidationError} when any signal's `ruleId` is not a known
 *   engine slug — propagates from `mapEngineSlugToOpenSipRuleId`.
 */
export function renderSarifOpenSip(
  signals: readonly Signal[],
  context: RenderSarifContext,
): string {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();

  for (const signal of signals) {
    const mappedRuleId = mapEngineSlugToOpenSipRuleId(signal.ruleId);
    ruleIds.add(mappedRuleId);

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
      ruleId: mappedRuleId,
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
            name: context.tool,
            version: context.toolVersion,
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
