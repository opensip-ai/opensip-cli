/**
 * createGraphSignal — the graph rule signal factory (north-star §5.9, release
 * launch).
 *
 * Graph rules used to hand-assemble fingerprint-relevant identity in every body:
 * `createSignal({ source: 'graph', ruleId: 'graph:<slug>', severity:
 * applySeverityOverride(base, 'graph:<slug>', config), … })`. This factory STAMPS
 * that identity from the rule's slug + config — `source` is always `'graph'`,
 * `ruleId` IS the slug, and the override clamp is applied internally — so a rule
 * names its slug once and never retypes `source`/`ruleId` or re-calls the override.
 * Output is byte-identical to the former hand-assembly.
 *
 * The `body.severity` is the rule's per-signal CHOICE (its data, not identity);
 * the override (`GraphConfig.severityOverrides[slug]`) is applied on top here.
 */

import {
  createSignal,
  type Signal,
  type SignalCategory,
  type SignalRepair,
  type SignalSeverity,
} from '@opensip-cli/core';

import { applySeverityOverride } from './_severity-override.js';

import type { GraphConfig } from '../types.js';

/** The per-signal data a graph rule supplies — everything EXCEPT the stamped identity. */
export interface GraphSignalBody {
  /** The rule's chosen base severity for this signal (clamped by any override). */
  readonly severity: SignalSeverity;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- mirrors Signal.category (open at the plugin layer)
  readonly category: SignalCategory | string;
  readonly message: string;
  /**
   * Location on the primary site. **`column` is 0-based** (catalog / tree-sitter
   * / TS character space). {@link createGraphSignal} lifts it to the Signal
   * 1-based contract (ADR-0179) before `createSignal`.
   */
  readonly code?: { file?: string; line?: number; column?: number };
  readonly suggestion?: string;
  readonly metadata?: Record<string, unknown>;
  readonly repair?: SignalRepair;
}

/**
 * Lift a graph occurrence column (0-based, parser-native) to Signal 1-based
 * (ADR-0179). Non-finite values are left for `createSignal` to omit.
 */
function graphColumnToSignalColumn(column: number | undefined): number | undefined {
  if (typeof column !== 'number' || !Number.isFinite(column)) return undefined;
  return column + 1;
}

/**
 * Build a graph {@link Signal}, stamping `source: 'graph'` + `ruleId: slug` and
 * applying the per-slug severity override — the rule supplies only its slug, the
 * active config, and the per-signal body.
 */
export function createGraphSignal(
  slug: string,
  config: GraphConfig,
  body: GraphSignalBody,
): Signal {
  const code =
    body.code === undefined
      ? undefined
      : {
          ...body.code,
          ...(body.code.column === undefined
            ? {}
            : { column: graphColumnToSignalColumn(body.code.column) }),
        };
  return createSignal({
    source: 'graph',
    ruleId: slug,
    severity: applySeverityOverride(body.severity, slug, config),
    category: body.category,
    message: body.message,
    code,
    suggestion: body.suggestion,
    metadata: body.metadata,
    repair: body.repair,
  });
}
