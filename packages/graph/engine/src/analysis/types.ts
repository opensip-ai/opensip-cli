/**
 * Shared types for the analysis layer.
 *
 * The graph tool's rules return `GraphFinding[]`. These are converted to
 * the standard `FindingOutput` shape from `@opensip-tools/contracts` at
 * the CLI surface — `metadata` is dropped because `FindingOutput` is the
 * stable cross-tool contract. Internal callers (Code Paths panel,
 * graph-aware renderer) keep `metadata` by reading the in-memory
 * GraphFinding directly.
 */

export interface GraphFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  /**
   * Rule-specific structured data. See spec §6.3 for the per-rule fields.
   * `confidence` is universal across graph signals.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}
