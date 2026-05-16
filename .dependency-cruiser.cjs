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
 *   4. @opensip-tools/checks-*       — fitness check packs (depend on fitness)
 *   5. @opensip-tools/cli            — entry point (depends on every tool)
 *
 * Forbidden edges enforce that dependencies flow from lower-numbered layers
 * upward only — a higher layer must never reach DOWN into a lower layer.
 *
 * Documented exceptions:
 *
 *   - @opensip-tools/lang-typescript depends on @opensip-tools/fitness for
 *     `filterContent` / `clearFilterCache` / `FilteredContent`. Those moved
 *     out of core during P1; the lang adapter still re-exports them. Mild
 *     architectural smell but contained — see decisions D14 / P1 summary.
 *     Allowed by the `lang-typescript-fitness-exception` rule below.
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
        'point, or language packs.',
      from: { path: '^packages/contracts/src/' },
      to: {
        path: [
          '^@opensip-tools/cli($|/)',
          '^@opensip-tools/fitness',
          '^@opensip-tools/simulation',
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
    {
      name: 'graph-no-cli',
      severity: 'error',
      comment:
        'Tool packages must not depend on the CLI entry point. Use the ' +
        'ToolCliContext from @opensip-tools/core to call back into render / ' +
        'maybeOpenDashboard. Adding cli would create a cycle (cli depends ' +
        'on graph).',
      from: { path: '^packages/graph/' },
      to: { path: '^@opensip-tools/cli($|/)' },
    },
    {
      name: 'graph-typescript-only-on-lang-typescript',
      severity: 'error',
      comment:
        'graph depends on lang-typescript by design (TS-first scope). ' +
        'It must not depend on any other lang-* pack — adding multi-language ' +
        'support is a deliberate scope expansion that should be reviewed.',
      from: { path: '^packages/graph/' },
      to: {
        path: [
          '^@opensip-tools/lang-rust',
          '^@opensip-tools/lang-python',
          '^@opensip-tools/lang-go',
          '^@opensip-tools/lang-java',
          '^@opensip-tools/lang-cpp',
        ],
      },
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
    //
    // Documented exception: lang-typescript depends on fitness for
    // filterContent (the content-filter API moved out of core during P1).
    // Allowed; flagged only if any OTHER lang pack starts importing from
    // fitness.
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
      name: 'lang-no-fitness-except-typescript',
      severity: 'error',
      comment:
        'Language adapters live below fitness in the layer order. The single ' +
        'documented exception is lang-typescript, which re-exports filterContent ' +
        'from fitness for legacy compatibility (P1 D14 / D11 in the multi-language ' +
        'decisions log). Any other lang pack importing fitness widens the smell.',
      from: {
        path: '^packages/languages/lang-',
        pathNot: '^packages/languages/lang-typescript/',
      },
      to: { path: '^@opensip-tools/fitness' },
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
