// @fitness-ignore-file no-markdown-references -- docs/plans/* pointers in JSDoc are stable internal references.
/**
 * @fileoverview Public option shape for `executeGraph`.
 *
 * Extracted so the orchestrator (`graph.ts`) and the mode helpers
 * (`graph-modes.ts`) can share the same interface without one
 * importing from the other.
 *
 * Language-neutral surface per the graph-cli-language-neutral-scoping
 * spec — positional `[paths...]`, `--workspace`, `--language <name>`
 * replace the prior TypeScript-flavored `--package` / `--packages`
 * flags (which were never publicly released — D11 hard-removes them).
 */

import type { ResolutionMode } from '../types.js';

export interface GraphCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly noCache?: boolean;
  /**
   * `--resolution <mode>`: edge resolution tier. `'exact'` (default) is
   * the semantic, type-checker-backed path; `'fast'` is the syntactic
   * (name + import-graph) path that skips the checker for a large
   * cold-build speedup, at the cost of approximate edges. Optional here
   * because programmatic callers and tests may omit it; the orchestrator
   * normalizes a missing value to `'exact'`.
   */
  readonly resolution?: ResolutionMode;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly baseline?: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
  /**
   * Positional `[paths...]`. Empty/undefined means whole-project scope.
   * Each path must be an existing directory (absolute or relative to
   * `cwd`). Multiple paths run sequentially in-process and aggregate
   * into one session (D12).
   */
  readonly paths?: readonly string[];
  /**
   * `--workspace`: fan the run across every workspace unit returned by
   * each detected adapter's `discoverWorkspaceUnits`. Polyglot per
   * spec D8b: in a multi-language repo all adapters' units are
   * aggregated into one combined fan-out.
   */
  readonly workspace?: boolean;
  /**
   * `--language <name>`: force a single language adapter. Suppresses
   * marker-based detection. Errors if the name is not registered.
   * Also drives the D14 mixed mismatch policy at the end of the run.
   */
  readonly language?: string;
  /**
   * `-v, --verbose`: when true, the renderer includes the detailed
   * catalog / findings-by-rule / entry-points sections in addition to
   * the one-line summary. Default (false) shows the summary + footer
   * hint only, matching fit's surface.
   */
  readonly verbose?: boolean;
  /**
   * Optional concurrency cap for `--workspace`. Defaults to
   * `os.cpus().length - 1`. Exposed primarily for tests.
   */
  readonly concurrency?: number;
  /**
   * Path to the CLI entry script. `--workspace` children invoke
   * `node <cliScript> graph <rootDir> --json`. Tools wiring
   * `executeGraph` should pass `process.argv[1]`.
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
