/**
 * @fileoverview Core finding and result types for fitness checks
 *
 * CheckResult carries Signal[]. Factory functions
 * (createResultWithSignals, createErrorResult) provide
 * the standard way to construct check results.
 */

import { countErrors, countWarnings } from './severity.js';

import type { DirectiveEntry } from '../framework/directive-inventory.js';
import type { Signal } from '@opensip-tools/core';

// =============================================================================
// SEVERITY
// =============================================================================

/**
 * Severity level for findings and violations.
 */
export type FindingSeverity = 'error' | 'warning';

/**
 * Alias for FindingSeverity — used by simplified check.ts types.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- public re-export under a shorter name for ergonomics
export type Severity = FindingSeverity;

/**
 * A single finding from a fitness check (output format).
 */
export interface Finding {
  readonly message: string;
  readonly severity: Severity;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Output from a tool-based check.
 */
export interface ToolOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// =============================================================================
// CHECK RESULT
// =============================================================================

/**
 * Check info for display.
 */
export interface CheckInfo {
  /** Summary label (e.g., "142/150 files compliant") */
  readonly label: string;
}

/**
 * Metadata about a check run.
 */
export interface CheckResultMetadata {
  /** Total items scanned */
  readonly totalItems: number;
  /** Signals (same reference as top-level) */
  readonly signals: readonly Signal[];
  /** Duration in milliseconds */
  readonly durationMs?: number;
  /** Number of files scanned from filesystem */
  readonly filesScanned?: number;
  /** Item type (e.g., 'files', 'modules') */
  readonly itemType?: string;
  /** Extra metadata */
  readonly extra?: Record<string, unknown>;
}

/**
 * Result of running a fitness check.
 * Now carries universal Signal[] instead of domain-specific violations.
 */
export interface CheckResult {
  /** Whether the check passed (no errors) */
  readonly passed: boolean;
  /** Number of error-level signals */
  readonly errors: number;
  /** Number of warning-level signals */
  readonly warnings: number;
  /** All signals */
  readonly signals: readonly Signal[];
  /** Display info */
  readonly info: CheckInfo;
  /** Run metadata */
  readonly metadata: CheckResultMetadata;
  /** Count of violations ignored via directives */
  readonly ignoredCount?: number;
  /** Directives that actually suppressed signals during this check's execution */
  readonly appliedDirectives?: readonly DirectiveEntry[];
}

// =============================================================================
// ITEM TYPES
// =============================================================================

/**
 * Item types for check info display.
 */
export type ItemType =
  | 'files'
  | 'modules'
  | 'packages'
  | 'functions'
  | 'classes'
  | 'components'
  | 'tests'
  | 'endpoints'
  | 'dependencies'
  | 'issues'
  | 'violations'
  | 'rules'
  | 'recipes'
  | 'checks';

const ITEM_TYPE_SINGULAR: Record<ItemType, string> = {
  files: 'file',
  modules: 'module',
  packages: 'package',
  functions: 'function',
  classes: 'class',
  components: 'component',
  tests: 'test',
  endpoints: 'endpoint',
  dependencies: 'dependency',
  issues: 'issue',
  violations: 'violation',
  rules: 'rule',
  recipes: 'recipe',
  checks: 'check',
};

/**
 * Get a human-readable label for an item type.
 */
export function getItemTypeLabel(type: ItemType, count: number): string {
  return count === 1 ? ITEM_TYPE_SINGULAR[type] : type;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Factory for creating CheckInfo objects.
 */
export const CheckInfoFactory = Object.freeze({
  compliance(compliantItems: number, totalItems: number, unit: string): CheckInfo {
    return { label: `${compliantItems}/${totalItems} ${unit} compliant` };
  },
  violations(count: number, unit: string): CheckInfo {
    return { label: count === 0 ? `No ${unit}` : `${count} ${unit}` };
  },
});

/**
 * Create a result with signals.
 */
export function createResultWithSignals(
  info: CheckInfo,
  signals: readonly Signal[],
  totalItems: number,
  options?: {
    ignoredCount?: number;
    durationMs?: number;
    filesScanned?: number;
    itemType?: string;
    extra?: Record<string, unknown>;
  },
): CheckResult {
  const errors = countErrors(signals);
  const warnings = countWarnings(signals);

  return {
    passed: errors === 0,
    errors,
    warnings,
    signals,
    info,
    metadata: {
      totalItems,
      signals,
      durationMs: options?.durationMs,
      filesScanned: options?.filesScanned,
      itemType: options?.itemType,
      extra: options?.extra,
    },
    ...(options?.ignoredCount !== undefined && options.ignoredCount > 0
      ? { ignoredCount: options.ignoredCount }
      : {}),
  };
}

/**
 * Create an error result (for check failures).
 */
export function createErrorResult(message: string, error?: Error): CheckResult {
  return {
    passed: false,
    errors: 1,
    warnings: 0,
    signals: [],
    info: { label: `Error: ${message}` },
    metadata: {
      totalItems: 0,
      signals: [],
      extra: error
        ? { originalError: error.message, ...(error.stack ? { stack: error.stack } : {}) }
        : undefined,
    },
  };
}
