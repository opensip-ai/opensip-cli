/**
 * @fileoverview Public option shape for `executeGraph`.
 *
 * Extracted so the orchestrator (`graph.ts`) and the mode helpers
 * (`graph-modes.ts`) can share the same interface without one
 * importing from the other.
 */

export interface GraphCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly noCache?: boolean;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly baseline?: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
  /**
   * Optional --package <name|path> scope. When set, the run targets a
   * single workspace package's tsconfig instead of the whole project.
   * See docs/plans/graph-performance-improvements.md Phase 6.
   */
  readonly packageScope?: string;
  /**
   * Optional --packages flag (no argument). When set, the run fans out
   * across every workspace package under packages/** with a tsconfig.
   * Each package runs in its own child process; findings are
   * aggregated in the parent. Wave 3 of the perf plan.
   */
  readonly allPackages?: boolean;
  /**
   * Optional concurrency cap for --packages. Defaults to
   * `os.cpus().length - 1`. Exposed primarily for tests.
   */
  readonly packagesConcurrency?: number;
  /**
   * Path to the CLI entry script. When --packages is set, child
   * processes invoke `node <cliScript> graph --package <dir> --json`.
   * Tools wiring `executeGraph` should pass `process.argv[1]`.
   */
  readonly cliScript?: string;
  /**
   * --catalog-output <path>. When set, runs in catalog-JSON emission
   * mode: walks the engine's `Catalog` + edges, derives opensip-
   * compatible symbol/edge IDs, and writes a `CatalogExport` JSON
   * document to the path. File output (not stdout) because catalog
   * JSON for 100k-file repos exceeds practical stdout buffer sizes.
   *
   * Required companion opts when set: `tenantId`, `repoId`, `gitSha`.
   * `runId` is auto-generated if not provided.
   *
   * Phase 3 Task 3.4 per opensip DEC-498. Phase 6's
   * EngineSubprocessPort invokes this mode per commit-sync run.
   */
  readonly catalogOutput?: string;
  /** Tenant scope for catalog-output provenance. */
  readonly tenantId?: string;
  /** Repository scope — applied to every row in catalog-output. */
  readonly repoId?: string;
  /** Commit SHA the catalog was extracted at — provenance for every row. */
  readonly gitSha?: string;
  /** Optional UUID for the catalog-output run. Auto-generated if absent. */
  readonly runId?: string;
}
