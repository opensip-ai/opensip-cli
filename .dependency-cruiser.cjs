// @ts-check
/**
 * dependency-cruiser config — enforces the v1.0 layered architecture.
 *
 * Layer order (lower depends on higher only):
 *
 *   1. @opensip-tools/core           — kernel
 *   2. @opensip-tools/contracts      — shared contract types (CliOutput, exit codes, persistence)
 *   3. @opensip-tools/lang-*         — language adapters (depend on core)
 *   3. @opensip-tools/fitness        — fitness engine + cli/* commands
 *   3. @opensip-tools/simulation     — simulation engine + cli/* commands
 *   3. @opensip-tools/dashboard      — HTML report generator (depends on core + contracts)
 *   4. @opensip-tools/checks-*       — fitness check packs (depend on fitness)
 *   5. @opensip-tools/cli            — entry point (depends on every tool)
 *
 * Forbidden edges enforce that dependencies flow from lower-numbered layers
 * upward only — a higher layer must never reach DOWN into a lower layer.
 *
 * The previous lang-typescript → fitness back-edge for filterContent was
 * paid down (Wave 3 Chain E / Phase D3): filterContent / clearFilterCache /
 * FilteredContent now live in @opensip-tools/lang-typescript, and the
 * `lang-no-fitness-except-typescript` exception has been deleted.
 *
 * Wave 3 Chain C extracted @opensip-tools/dashboard out of contracts so
 * Tools that don't render the report no longer pull dashboard code into
 * their dependency closure. The `dashboard-imports-only-core-contracts`
 * rule pins the new package's dep allowlist.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // -------------------------------------------------------------------
    // Generic hygiene
    // -------------------------------------------------------------------
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies within any package',
      from: {},
      to: { circular: true },
    },
    // no-orphans intentionally NOT enforced here. With tsPreCompilationDeps
    // off (set below), dep-cruiser can't see `import type` and `export type`
    // edges, so every dedicated types module looks orphaned. Orphan / dead-
    // export detection lives in knip, which understands TypeScript barrel
    // re-exports natively. dep-cruiser stays focused on architecture rules
    // (no-circular, layer enforcement) where it's the right tool.
    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment: 'Do not import from deprecated/removed Node core modules',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: ['^(punycode|domain|constants|sys|_linklist|_stream_wrap)$'],
      },
    },
    {
      name: 'not-to-spec',
      severity: 'error',
      comment: "Production code must not import test specs",
      from: { pathNot: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
      to: { path: ['/__tests__/', '\\.test\\.(ts|tsx)$'] },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        "Source code must not import devDependencies. Move the package to " +
        "dependencies or refactor the import out of source.",
      from: {
        path: '^packages/',
        pathNot: ['/__tests__/', '\\.test\\.(ts|tsx)$'],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — core (the kernel) imports nothing from the workspace
    // -------------------------------------------------------------------
    {
      name: 'core-imports-nothing-workspace',
      severity: 'error',
      comment:
        'core is the kernel. It must not depend on contracts, cli, fitness, ' +
        'simulation, lang-*, or checks-*. Anything else inverts the layering.',
      from: { path: '^packages/core/src/' },
      to: {
        path: [
          '^@opensip-tools/contracts',
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/fitness',
          '^@opensip-tools/simulation',
          '^@opensip-tools/lang-',
          '^@opensip-tools/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — contracts depends only on core
    // -------------------------------------------------------------------
    {
      name: 'contracts-imports-core-only',
      severity: 'error',
      comment:
        'contracts holds the CliOutput / exit codes / persistence types used ' +
        'by every tool. It must not import from any tool, the cli entry ' +
        'point, language packs, or dashboard.',
      from: { path: '^packages/contracts/src/' },
      to: {
        path: [
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/fitness',
          '^@opensip-tools/simulation',
          '^@opensip-tools/dashboard',
          '^@opensip-tools/lang-',
          '^@opensip-tools/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — dashboard depends only on core + contracts
    // -------------------------------------------------------------------
    {
      name: 'dashboard-imports-only-core-contracts',
      severity: 'error',
      comment:
        'dashboard renders the self-contained HTML report from session data ' +
        'and a graph catalog. It depends on core (logger, paths) and ' +
        'contracts (StoredSession / CheckCatalogEntry / GraphCatalog types). ' +
        'It must not depend on any tool engine, the CLI, language adapters, ' +
        'or check packs.',
      from: { path: '^packages/dashboard/src/' },
      to: {
        path: [
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/fitness',
          '^@opensip-tools/simulation',
          '^@opensip-tools/graph',
          '^@opensip-tools/lang-',
          '^@opensip-tools/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — fitness / simulation must not import from the CLI
    // -------------------------------------------------------------------
    {
      name: 'fitness-no-cli',
      severity: 'error',
      comment:
        'Tool packages must not depend on the CLI entry point — that creates ' +
        'a cycle (cli depends on fitness). Tools call back into shared CLI ' +
        'infrastructure via the ToolCliContext interface from core.',
      from: { path: '^packages/fitness/' },
      to: { path: '^@opensip-tools/cli($|/)' },
    },
    {
      name: 'simulation-no-cli',
      severity: 'error',
      comment:
        'Tool packages must not depend on the CLI entry point. Use the ' +
        'ToolCliContext from @opensip-tools/core to call back into render / ' +
        'maybeOpenDashboard.',
      from: { path: '^packages/simulation/' },
      to: { path: '^@opensip-tools/cli($|/)' },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — checks-* must not depend on cli/contracts
    // -------------------------------------------------------------------
    {
      name: 'check-pack-no-cli',
      severity: 'error',
      comment:
        'Check packs are self-contained units of fitness-domain logic. They ' +
        'depend on fitness (for defineCheck etc.) and core (for languages, ' +
        'errors). They must not depend on the CLI or contracts.',
      from: { path: '^packages/fitness/checks-' },
      to: {
        path: [
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/contracts',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — lang-* must not depend on cli/contracts/checks-*
    // and must not reach UP into fitness/simulation. The previous
    // `lang-no-fitness-except-typescript` exception was paid down by
    // moving filterContent / clearFilterCache / FilteredContent into
    // @opensip-tools/lang-typescript itself (Wave 3 Chain E / Phase D3).
    // -------------------------------------------------------------------
    {
      name: 'lang-no-cli-or-contracts',
      severity: 'error',
      comment:
        'Language adapter packages depend only on core (for the LanguageAdapter ' +
        'contract). They must not reach into the CLI, contracts, or check packs.',
      from: { path: '^packages/languages/lang-' },
      to: {
        path: [
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/contracts',
          '^@opensip-tools/checks-',
        ],
      },
    },
    {
      name: 'lang-no-fitness',
      severity: 'error',
      comment:
        'Language adapters live below fitness in the layer order and must not ' +
        'reach up into it. (The historical lang-typescript exception for ' +
        'filterContent was paid down by moving the symbol into lang-typescript.)',
      from: { path: '^packages/languages/lang-' },
      to: { path: '^@opensip-tools/fitness' },
    },

    // -------------------------------------------------------------------
    // graph tool — staged-pipeline architecture invariants (§9, AC-9).
    // -------------------------------------------------------------------
    {
      name: 'graph-no-cli',
      severity: 'error',
      comment:
        'Graph is a Tool plugin; it must not depend on the CLI entry point. ' +
        'Tool callbacks happen through the ToolCliContext interface from core.',
      from: { path: '^packages/graph/' },
      to: { path: '^@opensip-tools/cli($|/)' },
    },
    {
      name: 'graph-no-check-packs',
      severity: 'error',
      comment:
        'Graph sits in the tools/lang peer layer. It must not import any check pack.',
      from: { path: '^packages/graph/engine/src/' },
      to: { path: '^@opensip-tools/checks-' },
    },
    {
      name: 'graph-rules-no-parser',
      severity: 'error',
      comment:
        'Rules consume frozen catalog/indexes only. They must not import the ' +
        'TypeScript parser, any pipeline stage, or the lang-typescript adapter.',
      from: { path: '^packages/graph/engine/src/rules/' },
      to: {
        path: [
          '^typescript$',
          '^packages/graph/engine/src/pipeline/',
          '^packages/graph/engine/src/lang-typescript/',
        ],
      },
    },
    {
      name: 'graph-renderers-no-pipeline',
      severity: 'error',
      comment:
        'Renderers consume Signal[] and a RenderContext. They do not see the ' +
        'catalog or any rule logic.',
      from: { path: '^packages/graph/engine/src/render/' },
      to: {
        path: [
          '^packages/graph/engine/src/(pipeline|rules)/',
          '^packages/graph/engine/src/lang-typescript/',
        ],
      },
    },
    {
      name: 'graph-visitors-resolvers-disjoint',
      severity: 'error',
      comment:
        'Inventory visitors handle declarations; edge resolvers handle call ' +
        'sites. They share helpers but not each other.',
      from: { path: '^packages/graph/engine/src/lang-typescript/inventory-visitors/' },
      to: { path: '^packages/graph/engine/src/lang-typescript/edge-resolvers/' },
    },
    {
      name: 'graph-resolvers-visitors-disjoint',
      severity: 'error',
      comment:
        'Symmetric counterpart of graph-visitors-resolvers-disjoint.',
      from: { path: '^packages/graph/engine/src/lang-typescript/edge-resolvers/' },
      to: { path: '^packages/graph/engine/src/lang-typescript/inventory-visitors/' },
    },
    {
      // PR 3 of plan docs/plans/10-graph-language-pluggability.md.
      // After parseProject and cacheKey moved into the adapter, the
      // engine has zero direct imports of `'typescript'` outside the
      // lang-typescript subtree.
      name: 'graph-no-typescript-import-outside-lang-typescript',
      severity: 'error',
      comment:
        'Only the lang-typescript adapter subtree may import the TypeScript ' +
        'compiler API. The engine itself routes through the GraphLanguageAdapter ' +
        'contract from lang-adapter/.',
      from: {
        path: '^packages/graph/engine/src/',
        pathNot: '^packages/graph/engine/src/lang-typescript/',
      },
      to: { path: '^typescript$' },
    },
    {
      // PR 3 of plan docs/plans/10-graph-language-pluggability.md.
      // pipeline/, cache/, rules/, render/ are language-agnostic.
      // They MUST NOT reach into any lang-* adapter directory; instead
      // they consume the catalog (built by the orchestrator from
      // adapter outputs) and adapter-supplied hints via the contract.
      name: 'graph-pipeline-no-lang-import',
      severity: 'error',
      comment:
        'pipeline/, cache/, rules/, render/ are language-agnostic. They must ' +
        'not import from any lang-* adapter directory.',
      from: {
        path: '^packages/graph/engine/src/(?:pipeline|cache|rules|render)/',
      },
      to: { path: '^packages/graph/engine/src/lang-' },
    },
    {
      // PR 3 of plan docs/plans/10-graph-language-pluggability.md.
      // The orchestrator routes through the lang-adapter registry,
      // not a specific adapter. tool.ts and bootstrap.ts are the
      // bootstrap points — they import first-party adapters to
      // register them; no cli/* file may.
      name: 'graph-orchestrate-no-direct-lang-import',
      severity: 'error',
      comment:
        'cli/* (including the orchestrator) routes through ' +
        'lang-adapter/registry only, not a specific lang-* adapter. ' +
        'bootstrap.ts and tool.ts are the documented exceptions for ' +
        'first-party adapter registration; they live at the engine ' +
        'root, not under cli/.',
      from: {
        path: '^packages/graph/engine/src/cli/',
      },
      to: {
        path: [
          '^packages/graph/engine/src/lang-typescript/',
          '^packages/graph/engine/src/lang-python/',
          '^packages/graph/engine/src/lang-rust/',
        ],
      },
    },
    {
      // PR 5/6 of plan docs/plans/10-graph-language-pluggability.md.
      // Only adapter subtrees may import tree-sitter and its grammars;
      // the engine itself routes through the GraphLanguageAdapter
      // contract.
      name: 'graph-no-tree-sitter-import-outside-lang-packs',
      severity: 'error',
      comment:
        'Only language-adapter subtrees (lang-python, lang-rust, ...) ' +
        'may import tree-sitter or its grammars. The engine itself uses ' +
        'the GraphLanguageAdapter contract from lang-adapter/.',
      from: {
        path: '^packages/graph/engine/src/',
        pathNot: [
          '^packages/graph/engine/src/lang-python/',
          '^packages/graph/engine/src/lang-rust/',
        ],
      },
      to: { path: '^tree-sitter' },
    },
    {
      // Documented exception: graph imports SARIF helpers from fitness
      // (DEC-3 in docs/plans/graph-tool-v2-design.md Appendix C).
      // Both packages sit at the tools/lang peer layer; the import is
      // restricted to render/sarif.ts via the rule below. Listed as
      // 'info' so the build records the edge but doesn't reject it.
      name: 'graph-may-import-fitness-sarif',
      severity: 'info',
      comment:
        'Graph imports SARIF helpers from fitness as a peer-layer dependency. ' +
        'Allowed cross-tool import documented in DEC-3.',
      from: { path: '^packages/graph/engine/src/render/sarif\\.ts$' },
      to: { path: '^@opensip-tools/fitness$' },
    },

    // -------------------------------------------------------------------
    // graph dashboard v0.3 — Code Paths panel architectural invariants
    // (§9.1 of docs/plans/graph-dashboard-v3-design.md). The panel lives
    // in @opensip-tools/dashboard; it consumes the graph catalog by JSON
    // shape only. Each rule below codifies a single architectural-
    // invariant claim from the design doc.
    // -------------------------------------------------------------------
    {
      name: 'dashboard-no-graph-import',
      severity: 'error',
      comment:
        'AI-3: dashboard code-paths must not import @opensip-tools/graph; ' +
        'consume the catalog by JSON shape only.',
      from: { path: '^packages/dashboard/src/code-paths' },
      to: { path: '^@opensip-tools/graph(/|$)' },
    },
    {
      name: 'dashboard-code-paths-self-contained',
      severity: 'error',
      comment:
        'MI-1: code-paths/* may import only from @opensip-tools/contracts ' +
        '(for GraphCatalog types), @opensip-tools/core, dashboard siblings, ' +
        'and Node built-ins. No other cross-package imports.',
      from: { path: '^packages/dashboard/src/code-paths/' },
      to: {
        path: '^@opensip-tools/(?!(contracts|core|dashboard)(/|$))',
        pathNot: '^node:',
      },
    },
    {
      name: 'dashboard-views-disjoint',
      severity: 'error',
      comment:
        'MI-2: code-paths/view-*.ts files must not import each other. They ' +
        'share state through views-registry, filterState, and indexes only.',
      from: { path: '^packages/dashboard/src/code-paths/view-' },
      to: { path: '^packages/dashboard/src/code-paths/view-' },
    },
    {
      name: 'dashboard-algorithms-no-view-deps',
      severity: 'error',
      comment:
        'MI-3: pure-algorithm modules (scc, search, trace) must not import ' +
        'view files or function-card.',
      from: { path: '^packages/dashboard/src/code-paths/(scc|search|trace)\\.ts$' },
      to: { path: '^packages/dashboard/src/code-paths/(view-|function-card\\.ts)' },
    },
    {
      name: 'dashboard-no-side-stylesheets',
      severity: 'error',
      comment:
        'AI-4: new CSS must extend dashboard/css.ts. No external .css imports ' +
        'inside the dashboard package.',
      from: { path: '^packages/dashboard/src/' },
      to: { path: '\\.css$' },
    },
    {
      name: 'dashboard-no-ui-framework',
      severity: 'error',
      comment:
        'AI-2: dashboard must not depend on any UI framework or visualization library.',
      from: { path: '^packages/dashboard/src/' },
      to: {
        path: '^(react|preact|vue|svelte|@?solidjs|d3|d3-.+|three|cytoscape|sigma|vis-network|@?angular)(/|$)',
      },
    },
  ],

  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', '\\.turbo'],
    },

    // Treat workspace package names as workspace-internal (not 'npm') so the
    // forbidden rules can match by package path.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
    },

    tsConfig: {
      // Use each package's tsconfig automatically — same setup ESLint uses.
      fileName: 'tsconfig.json',
    },

    // Type-only imports are stripped at compile time, so a file A that
    // `import type`s from B and B that imports A at runtime is safe — no
    // runtime cycle. Setting tsPreCompilationDeps to false makes dep-cruiser
    // ignore type-only edges, matching what actually runs.
    //
    // Trade-off: type-only cycles are still a structural smell (often a sign
    // that the type belongs in a third file), but cleaning them up is a real
    // refactor in its own right (e.g. moving LoadScenarioConfig out of
    // simulation/engine/src/kinds/load/define.ts). Tracked separately; not
    // gated by this rule.
    tsPreCompilationDeps: false,

    includeOnly: '^packages/',
    exclude: {
      path: [
        '^packages/[^/]+/[^/]+/dist/',
        '^packages/[^/]+/dist/',
        '\\.test\\.(ts|tsx)$',
        '/__tests__/',
        '/__fixtures__/',
      ],
    },

    progress: { type: 'none' },

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
