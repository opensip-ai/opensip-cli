/**
 * Ambient declarations for the dashboard client bundle (L4 migration).
 *
 * The generated report `<script>` opens with a const block emitted by
 * `generator.ts` (sessions, the tool catalogs, the descriptor-derived Overview
 * maps, the per-tool session splits). The bundled client modules — which run in
 * that same `<script>` scope — read those as free identifiers. Declaring them in
 * a `declare global` block lets the client `tsconfig.json` type-check the modules
 * without each one re-deriving the inputs.
 *
 * This is a regular module (`export {}` makes it a module so `declare global`
 * augments the global scope) rather than a `.d.ts` — the stale-build-artifact
 * fitness check forbids `.d.ts` files in source directories, and a `declare
 * global` module emits no runtime code (esbuild never bundles it; tsc uses it for
 * type-checking only).
 *
 * The catalog entry shapes are tool domain vocabulary (fitness/sim/graph),
 * inlined as JSON and read structurally by the renderers — hence `unknown` for
 * the opaque tool-owned payloads and `readonly unknown[]` for the catalogs.
 *
 * Cross-module helpers that one migrated module needs from another (e.g.
 * `renderSessionTable`) are imported directly via `./<module>.js`, NOT declared
 * here — these globals are only the generator-injected data.
 */

import type { CatalogLike, IndexesLike } from './code-paths-types.js';
import type { CytoscapeFactory } from './cytoscape-types.js';

declare global {
  /** A persisted run row, as inlined by `generator.ts` (read structurally). */
  interface DashboardSession {
    id: string;
    tool: string;
    startedAt: string;
    recipe?: string;
    suiteRunId?: string;
    suiteName?: string;
    score: number;
    passed?: boolean;
    /** Persisted run health (ADR-0060). Legacy rows omit — infer from passed. */
    runOutcome?: 'passed' | 'failed' | 'degraded' | 'error';
    durationMs: number;
    cwd: string;
    /** opensip-cli version that produced the run (host-stamped). Legacy rows omit. */
    cliVersion?: string;
    /** Producing tool's engine (manifest) version. Absent when unversioned / legacy. */
    engineVersion?: string;
    /** Tool-owned opaque payload (fitness/sim/graph carry their own shapes). */
    payload?: {
      summary?: {
        total?: number;
        passed?: number;
        failed?: number;
        errors?: number;
        warnings?: number;
      };
      checks?: readonly unknown[];
    };
  }

  interface DashboardRunStep {
    id: string;
    runId: string;
    logicalStepKey: string;
    ordinal: number;
    attempt: number;
    tool: string;
    command: string;
    stableId: string;
    effectiveArgs?: Readonly<Record<string, unknown>>;
    exitCode: number;
    outcome: 'passed' | 'failed' | 'faulted';
    durationMs: number;
    verdictSummary?: {
      passed: boolean;
      errors: number;
      warnings: number;
      findings: number;
    };
    sessionId?: string;
    evidence?: unknown;
  }

  interface DashboardRun {
    id: string;
    name: string;
    source: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    exitCode: number;
    aggregate: {
      steps: number;
      passed: number;
      failed: number;
      faulted: number;
      errors: number;
      warnings: number;
    };
    scope?: {
      mode: 'changed' | 'full';
      source: string;
      ref?: string;
      changedFiles?: number;
      notice?: string;
    };
    reviewBrief?: ChangeImpactReviewBrief;
    legacySuiteRunId?: string;
    steps: readonly DashboardRunStep[];
  }

  interface ChangeImpactRisk {
    source: string;
    ruleId: string;
    message: string;
    severity: string;
    file: string;
    line?: number;
    column?: number;
    isNew: boolean;
    blastRadius?: {
      dependents: number;
      confidence: string;
      impactedFiles?: number;
    };
  }

  interface ChangeImpactReviewBrief {
    verdict: 'pass' | 'warn' | 'fail';
    changedFiles: number | null;
    topRisks: readonly ChangeImpactRisk[];
    newFindings: readonly ChangeImpactRisk[];
    baselineDelta: {
      available: boolean;
      added: number;
      removed: number;
      unchanged: number;
    };
    degraded: readonly { source: string; reason: string; code?: string }[];
    recommendedActions: readonly {
      priority: 'high' | 'medium' | 'low';
      message: string;
      source?: string;
      command?: string;
    }[];
    correlatedRisks?: readonly {
      id: string;
      title: string;
      severity: string;
      isNew: boolean;
      primary: { source: string; ruleId: string; file: string; line?: number };
      members: readonly {
        source: string;
        ruleId: string;
        file: string;
        line?: number;
      }[];
      reasons: readonly { confidence: string; message: string }[];
      blastRadius?: {
        dependents: number;
        confidence: string;
        impactedFiles?: number;
      };
    }[];
  }

  interface ChangeImpactFunctionModel {
    qualifiedName: string;
    filePath: string;
    line: number;
    package?: string;
    reason: string;
    bodyHash?: string;
    navigation: 'available' | 'catalog-unavailable' | 'not-found' | 'ambiguous';
  }

  interface ChangeImpactViewModel {
    runId: string;
    completedAt: string;
    durationMs: number;
    exitCode: number;
    verdict: 'pass' | 'warn' | 'fail';
    aggregate: DashboardRun['aggregate'];
    scope?: DashboardRun['scope'];
    reviewBrief?: ChangeImpactReviewBrief;
    reviewBriefState: 'available' | 'missing' | 'malformed';
    availability:
      | 'available'
      | 'projection-degraded'
      | 'step-faulted'
      | 'missing-session'
      | 'legacy'
      | 'malformed';
    availabilityReason: string;
    catalogMatch: 'matching' | 'mismatched' | 'missing-stored' | 'missing-current';
    zeroImpact: boolean;
    sourceTruncated: boolean;
    evidence?: {
      basisType: 'changed' | 'files';
      basisRef?: string;
      changedFiles: readonly string[];
      changedFunctions: readonly ChangeImpactFunctionModel[];
      impactedFunctions: readonly ChangeImpactFunctionModel[];
      impactedFiles: readonly string[];
      impactedPackages: readonly { name: string; functionCount: number }[];
      trust: {
        coverage: 'full' | 'partial' | 'unknown';
        fallback: string;
        fullyVerified: boolean;
        uncertainties: readonly {
          code: string;
          source: string;
          message: string;
          filePath?: string;
        }[];
      };
      recommendedCommands: readonly string[];
      truncated: boolean;
      backendOmitted: {
        changedFiles: number;
        changedFunctions: number;
        impactedFunctions: number;
        impactedFiles: number;
        impactedPackages: number;
        recommendedCommands: number;
      };
      detailTruncated: boolean;
      metadataOmitted: boolean;
    };
    reportOmitted: {
      changedFiles: number;
      changedFunctions: number;
      impactedFunctions: number;
      impactedFiles: number;
      impactedPackages: number;
      recommendedCommands: number;
      uncertainties: number;
      risks: number;
      newFindings: number;
      correlations: number;
      actions: number;
      degradations: number;
    };
  }

  // ---- Generator-injected data globals (the report <script> const block) ----

  const sessions: readonly DashboardSession[];
  const runs: readonly DashboardRun[];
  const changeImpactRuns: readonly ChangeImpactViewModel[];
  const changeImpactOmittedRuns: number;
  /**
   * Graph-catalog bounding (see `code-paths/bound-catalog.ts`). The inlined
   * catalog is byte-bounded, so a very large repository ships a subset of its
   * functions. Truncation MUST stay visible — a report that silently showed
   * 5,000 of 28,327 functions would read as complete.
   */
  const graphCatalogTotalFunctions: number;
  const graphCatalogOmittedFunctions: number;
  const REPORT_SELECTION: { view: 'change-impact'; runId?: string } | null;
  const fitSessions: readonly DashboardSession[];
  const simSessions: readonly DashboardSession[];
  const yagniSessions: readonly DashboardSession[];

  /**
   * Host-owned catch-all session bucket + tab id, emitted by generator.ts as
   * `const externalSessions = sessions.filter(s => !(s.tool in tabMap));` /
   * `const externalTabId = 'external';`. Sessions whose tool is not claimed by any
   * first-party tool tab (external-adapter scans — gitleaks / osv-scanner / trivy)
   * render in the "External Tools" tab via `renderExternalTab`, and the overview
   * row-click handler routes their rows to `externalTabId`.
   */
  const externalSessions: readonly DashboardSession[];
  const externalTabId: string;

  const checkCatalog: readonly unknown[];
  const recipeCatalog: readonly unknown[];
  const simScenarioCatalog: readonly unknown[];
  const simRecipeCatalog: readonly unknown[];

  /**
   * Yagni-owned detector catalog + run summary, emitted by generator.ts as
   * `const yagniCatalog = …;` / `const yagniSummary = …;`. The YAGNI tab reads
   * them structurally (entry shapes are yagni domain vocabulary owned by
   * @opensip-cli/yagni). `yagniSummary` is `null` when yagni contributed nothing.
   */
  const yagniCatalog: readonly unknown[];
  const yagniSummary: {
    detectorCount?: number;
    contractVersion?: string;
  } | null;

  /**
   * Graph-owned rule/recipe catalogs (Plan B), emitted by generator.ts as
   * `const graphRuleCatalog = …;` / `const graphRecipeCatalog = …;`. The Code
   * Paths panel's Catalog/Recipes subtabs read them structurally. Read via
   * `typeof graphRuleCatalog !== 'undefined'` at the call site, so they may be
   * absent in test-eval scopes that don't declare them.
   */
  const graphRuleCatalog: readonly unknown[];
  const graphRecipeCatalog: readonly unknown[];

  /**
   * Overview's `tool → inline badge style` and `tool → tab id` maps. Derived
   * from the first-party tab descriptors in `generator.ts` and emitted as page
   * globals so the descriptor derivation stays type-checked Node code rather than a
   * string template (F1/F8).
   */
  const toolBadgeStyles: Readonly<Record<string, string>>;
  const tabMap: Readonly<Record<string, string>>;

  // ---- Code Paths panel globals (declared by the still-string-emitted panel
  //      orchestrator + editor-protocol literal in generator.ts) ----

  /**
   * Editor deep-link scheme ('vscode' | 'cursor' | other | null), emitted by
   * generator.ts as a `const EDITOR_PROTOCOL = …;` literal. Read by editor-link.
   */
  const EDITOR_PROTOCOL: string | null;

  /**
   * The loaded graph catalog (the latest `graph` build), assigned by the panel
   * orchestrator (`code-paths.ts`, still string-emitted) at panel-init. `null`
   * until the inline `<script id="graph-catalog">` blob is parsed. The bundle
   * only READS it (function-card / views-registry); the orchestrator owns
   * the mutable binding.
   */
  const graphCatalog: CatalogLike | null;

  /**
   * The adjacency/index maps rebuilt from `graphCatalog`, assigned by the panel
   * orchestrator at Explore-render time. The bundle only reads it.
   */
  const graphIndexes: IndexesLike;

  // ---- Vendored Cytoscape runtime (the Visualization view) ----

  /**
   * The vendored `cytoscape` UMD global + its `cytoscape-dagre` layout
   * extension, both inlined ahead of the bundle by `dashboardCytoscapeVendorJs()`
   * (a 493KB third-party blob that is NOT part of this typed bundle). The
   * Visualization view (view-graph.ts) consumes them; guarded with
   * `typeof cytoscape === 'function'` since a non-graph report omits the blob.
   */
  const cytoscape: CytoscapeFactory;
  const cytoscapeDagre: unknown;
}

export {};
