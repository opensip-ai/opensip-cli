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

/**
 * Public option shape for `executeGraph` — the language-neutral surface shared
 * by the orchestrator (`graph.ts`) and the mode helpers (`graph-modes.ts`).
 * Programmatic callers and tests construct this directly; the CLI builds it
 * from parsed Commander flags.
 */
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
  /**
   * `--recipe <name>`: select a named subset of graph rules to evaluate.
   * Absent ⇒ the built-in `default` recipe (all rules, registration order
   * — identical to the historical behavior). Resolved to a `readonly Rule[]`
   * in the CLI layer and threaded into every run path as `RunGraphInput.rules`;
   * an unknown name raises a `ConfigurationError`.
   */
  readonly recipe?: string;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  /**
   * `--profile <path>`: write a stage-timing JSON artifact for this run.
   * Intended for cold-start diagnostics; relative paths resolve against
   * `cwd`.
   */
  readonly profileOutput?: string;
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
   * `--exact`: opt OUT of the default parallel SHARDED build engine and use
   * the single-program EXACT engine instead. Determinism (ADR-0032, superseding
   * ADR-0031): the build engine is chosen by THIS explicit flag (plus the
   * project's shardability) — never by `process.stdout.isTTY` or on-disk
   * discovery state. A bare `graph` uses the SHARDED engine (the default,
   * proven byte-equivalent to exact by the repo-scale equivalence guardrail);
   * `--exact` forces the single-program engine.
   *
   * The sharded engine is faster on large multi-package repos and — now that
   * it is proven byte-equivalent to exact — is the authoritative default.
   * `--exact` is the escape hatch for small/single-package repos (where exact
   * is the natural path anyway) and the oracle used to verify equivalence.
   * Sharding is always skipped for the whole-`--workspace` fan-out (which
   * already runs one isolated child process per unit) and for positional-path /
   * multi-path runs (those always use the exact engine).
   */
  readonly exact?: boolean;
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
  /**
   * `--list-files`: discovery-only mode. Resolve and print the source-file
   * set the run would analyze for the given scope (whole project, positional
   * subtrees, or `--workspace` fan-out) WITHOUT building the catalog, then
   * exit. The list is faithful to a real run — it reuses the adapter's
   * stage-0 `discoverFiles` (so `.d.ts` is excluded, TypeScript
   * extension-priority collisions are collapsed, and per-tsconfig
   * include/exclude is honored) — which makes it the canonical way to diff
   * graph's view of a repo against e.g. `git ls-files`. Composes with
   * `--json` for machine-readable output.
   */
  readonly listFiles?: boolean;
}
