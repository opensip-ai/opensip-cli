// @ts-check
/**
 * dependency-cruiser config — enforces the layered architecture.
 *
 * Layer order (lower numbers are more foundational; higher layers may depend
 * on lower layers, but lower layers must not import upward):
 *
 *   1. @opensip-tools/core           — kernel
 *   2. @opensip-tools/datastore      — SQLite + Drizzle persistence layer
 *   2. @opensip-tools/contracts      — shared contract types (SignalEnvelope, CommandResult, exit codes)
 *   2. @opensip-tools/tree-sitter    — grammar-agnostic parser substrate
 *   2. @opensip-tools/cli-ui         — shared Ink/React presentational primitives
 *   3. @opensip-tools/session-store  — session persistence over datastore/contracts
 *   3. @opensip-tools/output         — signal-envelope formatters + sinks
 *   3. @opensip-tools/config         — capability-configuration composer + schema registry (depends on core)
 *   3. @opensip-tools/lang-*         — language adapters
 *   3. @opensip-tools/dashboard      — HTML report generator (core + contracts)
 *   4. @opensip-tools/fitness        — fitness engine + cli/* commands
 *   4. @opensip-tools/simulation     — simulation engine + cli/* commands
 *   4. @opensip-tools/graph          — graph engine + cli/* commands
 *   5. @opensip-tools/checks-*       — fitness check packs (depend on fitness)
 *   5. @opensip-tools/graph-*        — graph adapter packs (depend on graph)
 *   6. opensip-tools                 — CLI composition root (depends on tools)
 *
 * Forbidden edges pin these import boundaries package by package; adjacent
 * packages at the same displayed layer can still have stricter allowlists.
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

// ---------------------------------------------------------------------------
// External-package guard families (ADR-0004 + ADR-0010).
//
// These two rules are unusual: their `to` targets an EXTERNAL npm package, not
// a workspace path. Every other forbidden rule here matches resolved
// `^packages/...` paths, and `options.includeOnly: '^packages/'` deliberately
// drops every node_modules edge before rules run — which is exactly why the
// dev-dep / drizzle-orm hygiene rules could not live here (see the notes by
// `tables-only-in-persistence`). An npm `to:` rule under a bare
// `includeOnly: '^packages/'` is therefore STRUCTURALLY INERT: the edge never
// enters the graph, so the rule cruises 0 dependencies and can never fire
// (verified empirically with a probe import — 0 dependencies cruised).
//
// To make the two ADR guards real, `options.includeOnly` below is a UNION:
// `^packages/` PLUS these two external families. That surfaces ONLY these
// specific node_modules edges (the OTel SDK family and web-tree-sitter) into
// the graph so the rules can match them; all other node_modules edges stay
// dropped, so no other rule's inertness assumption changes. The only real
// importers of either family — `packages/tree-sitter/` (web-tree-sitter) and
// `packages/cli/` (OTel SDK) — are exactly the packages the rules exempt, so
// the clean tree stays at 0 violations.
//
// The `[/+]` alternations match both the bare specifier (`@opentelemetry/sdk-…`)
// and a pnpm-store resolved path (`@opentelemetry+sdk-…@x.y.z`); the resolved
// `module`/`resolved` value depcruise reports for an unfollowed npm edge is the
// bare specifier, but matching both shapes is belt-and-braces.
// ---------------------------------------------------------------------------

// ADR-0004: the OpenTelemetry SDK family (exporter, sdk-*, context manager,
// propagator, resources). NOT `@opentelemetry/api` (the no-op facade, allowed
// everywhere) and NOT `@opentelemetry/core` / `@opentelemetry/semantic-conventions`.
const OTEL_SDK_FAMILY = String.raw`@opentelemetry[/+](sdk|exporter|context|propagator|resources)`;

// ADR-0010: the tree-sitter Parser substrate. Only `@opensip-tools/tree-sitter`
// and the `lang-*` adapters may import it; everyone else obtains parsed trees
// via `@opensip-tools/lang-*`.
const TREE_SITTER_PARSER = String.raw`(^|[/+])web-tree-sitter([/+]|$)`;

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
      comment: 'Production code must not import test specs',
      from: { pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`] },
      to: { path: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`] },
    },
    {
      name: 'no-cross-package-internal',
      severity: 'error',
      comment:
        "Production code must not import a package's `src/internal.ts` barrel — those are " +
        'test-only surfaces exposed via the `<pkg>/internal` subpath for cross-package test ' +
        'suites (ADR-0009). Use the package public barrel, or promote the symbol into it.',
      from: { pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`] },
      to: { path: String.raw`/src/internal\.ts$` },
    },
    // Dev-dependency hygiene ("production source must not import a
    // devDependency") is NOT a depcruise rule. `options.includeOnly: '^packages/'`
    // drops every node_modules edge before rules run, so a `to: { dependencyTypes:
    // ['npm-dev'] }` rule is structurally inert here (verified empirically with a
    // probe import of an external devDep). The former `not-to-dev-dep` rule was
    // removed for that reason. The invariant is enforced by ESLint
    // `import-x/no-extraneous-dependencies` (.config/eslint.config.mjs), which
    // resolves node_modules natively — that is the authoritative gate for it.

    // -------------------------------------------------------------------
    // Persistence ownership — keep the repository boundary a real seam, not
    // a convention. `DataStore.db` (a raw Drizzle handle) is public, so the
    // one thing standing between a stray module and another tool's tables is
    // reachability of that tool's table symbols. This rule confines the
    // schema/table modules to their owning persistence layer, so a module
    // cannot pair the public `db` handle with a foreign table to bypass its
    // repository. Persistence-owned code is the `datastore` + `session-store`
    // packages and each tool's `src/persistence/` repository layer.
    //
    // NOTE on scope: a rule confining raw `drizzle-orm` query-builder imports
    // (`sql`/`eq`/…) was considered but is unenforceable under this config —
    // `options.includeOnly: '^packages/'` drops every node_modules edge before
    // rules run, so any `to:` targeting an npm package is inert (verified: a
    // probe import of `drizzle-orm` from a non-persistence file is NOT flagged —
    // the same structural reason dev-dep hygiene cannot live here and is enforced
    // in ESLint instead; see the note above). The residual it would
    // have covered — `db.run(sql`raw SQL`)` with no table import — does not
    // reach a table *symbol*, so it falls outside the boundary this seam
    // protects. (Audit finding-3.)
    // -------------------------------------------------------------------
    {
      name: 'tables-only-in-persistence',
      severity: 'error',
      comment:
        'Schema/table modules (the `sqliteTable` definitions under a ' +
        '`src/persistence/` layer, or under `session-store/src/schema/`) may ' +
        'be imported ONLY by their owning persistence layer. A module that ' +
        'reaches a table symbol plus the public `DataStore.db` handle could ' +
        'bypass another module’s repository boundary; this forbids that. ' +
        '(Audit finding-3.)',
      from: {
        path: '^packages/',
        pathNot: [
          '/src/persistence/',
          '^packages/session-store/src/',
          '/__tests__/',
          String.raw`\.test\.(ts|tsx)$`,
        ],
      },
      to: {
        path: [String.raw`/src/persistence/schema\.ts$`, '^packages/session-store/src/schema/'],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — core (the kernel) imports nothing from the workspace
    // -------------------------------------------------------------------
    {
      name: 'core-imports-nothing-workspace',
      severity: 'error',
      comment:
        'core is the kernel. It must not depend on any other workspace package. ' +
        'Anything else inverts the layering.',
      from: { path: '^packages/core/src/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/core/',
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — tree-sitter is the grammar-agnostic substrate
    // (ADR-0010), between core and the lang-*/graph adapters.
    // -------------------------------------------------------------------
    {
      name: 'tree-sitter-imports-core-only',
      severity: 'error',
      comment:
        '@opensip-tools/tree-sitter is the grammar-agnostic tree-sitter substrate ' +
        '(ADR-0010): web-tree-sitter lifecycle + node accessors. It depends on ' +
        'web-tree-sitter (and optionally core) only, and must NOT import from ' +
        'datastore, contracts, cli, any tool, lang-*, checks-*, output, or the ' +
        'graph packages — those sit at or above it in the layer order. Keeping it ' +
        'graph-free is the whole point of the package (lang-* could not otherwise ' +
        'reach the parser without an illegal lang→graph edge).',
      from: { path: '^packages/tree-sitter/src/' },
      to: {
        path: [
          '^packages/datastore/',
          '^packages/contracts/',
          '^packages/config/',
          '^packages/cli/',
          '^packages/fitness/',
          '^packages/simulation/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/output/',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — datastore depends only on core
    // -------------------------------------------------------------------
    {
      name: 'datastore-imports-core-only',
      severity: 'error',
      comment:
        'datastore is paradigm-agnostic infrastructure. It depends on core ' +
        '(logger, errors) only. It must not import from contracts, cli, or any ' +
        'tool/lang/checks pack — domain schemas live with their owning packages.',
      from: { path: '^packages/datastore/src/' },
      to: {
        path: [
          '^packages/contracts/',
          '^packages/config/',
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
          '^packages/graph/',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — session-store depends on core + datastore +
    // contracts (StoredSession type) only.
    // -------------------------------------------------------------------
    {
      name: 'session-store-imports-core-datastore-contracts-only',
      severity: 'error',
      comment:
        'session-store owns session persistence. It depends on core, ' +
        'datastore, and contracts (StoredSession type) only — never a tool, ' +
        'cli, lang, check pack, graph, or simulation.',
      from: { path: '^packages/session-store/src/' },
      to: {
        path: [
          '^packages/config/',
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — output depends on core + contracts only.
    // -------------------------------------------------------------------
    {
      name: 'output-imports-core-contracts-only',
      severity: 'error',
      comment:
        'output hosts the pure signal-envelope formatters (json/sarif/table) ' +
        'and the effectful sinks (file/cloud). It depends on core ' +
        '(withRetry, logger) and contracts (SignalEnvelope type) only — never ' +
        'datastore, a tool, cli, lang, check pack, graph, or simulation.',
      from: { path: '^packages/output/src/' },
      to: {
        path: [
          '^packages/datastore/',
          '^packages/config/',
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — config depends on core (+ contracts) only.
    //
    // @opensip-tools/config is the capability-configuration layer (ADR-0023):
    // the config composer + schema registry. It sits at Layer 2/3 beside
    // output — it may import core (errors, yaml) and contracts (a re-exported
    // config type), and tools + the CLI may import it. It must NEVER reach UP
    // into datastore, a tool engine, the CLI, language packs, check packs, or
    // the output layer. core must not import config (pinned by
    // `core-imports-nothing-workspace` above).
    // -------------------------------------------------------------------
    {
      name: 'config-imports-core-contracts-only',
      severity: 'error',
      comment:
        'config hosts the capability-configuration composer + schema registry ' +
        '(ADR-0023). It depends on core (errors, yaml) and may re-export a ' +
        'contracts config type — nothing else. It must not import datastore, a ' +
        'tool engine, cli, lang, check pack, graph, simulation, or output.',
      from: { path: '^packages/config/src/' },
      to: {
        path: [
          '^packages/datastore/',
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
          '^packages/output/',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — targeting depends on core + config only (ADR-0037).
    //
    // @opensip-tools/targeting is the host file-targeting runtime substrate:
    // the generic TargetRegistry, the uniform glob expansion (resolveTargets /
    // preResolveAllTargets) and globalExcludes filtering any tool consumes via
    // scope.targets. It sits at the peer layer beside lang-*/output/config. It
    // may import core (the generic Registry<T> base — a kernel primitive, NOT
    // its tool vocabulary; it does not read currentScope) and config (the
    // targeting types), plus glob/minimatch — nothing else. It must NEVER reach
    // UP into datastore, contracts, a tool engine, the CLI, language packs,
    // check packs, graph, simulation, session-store, or the output layer.
    // -------------------------------------------------------------------
    {
      name: 'targeting-imports-config-core-only',
      severity: 'error',
      comment:
        'targeting hosts the generic file-targeting runtime (ADR-0037): the ' +
        'TargetRegistry, resolveTargets/preResolveAllTargets, and ' +
        'applyGlobalExcludes. It depends on core (the Registry<T> base) and ' +
        'config (targeting types) plus glob/minimatch — nothing else. It must ' +
        'not import datastore, contracts, a tool engine, cli, lang, check ' +
        'pack, graph, simulation, session-store, or output.',
      from: { path: '^packages/targeting/src/' },
      to: {
        path: [
          '^packages/datastore/',
          '^packages/contracts/',
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
          '^packages/session-store/',
          '^packages/output/',
        ],
      },
    },

    // -------------------------------------------------------------------
    // ADR-0011 — tool engines emit, never render/deliver.
    //
    // A tool run produces a SignalEnvelope and RETURNS it; the CLI
    // composition root maps flags → (formatter × sink) and owns rendering +
    // cloud/file egress. So a tool ENGINE must never reach into the output
    // package's pure formatters (json/sarif/table) or its effectful sinks
    // (file/http/cloud). These rules prevent the tool→output edge from
    // ever reappearing after Phases 5–6 removed it.
    //
    // THREE rules, because there are two import shapes:
    //   * a DEEP subpath import (`.../output/src/format/signal-sarif.js`)
    //     resolves straight into format/ or sink/ — caught by the two granular
    //     rules below;
    //   * a BARREL import (`@opensip-tools/output`) resolves to
    //     `packages/output/src/index.ts` (NOT format/ or sink/), so the
    //     granular rules can't see it — `tool-engines-no-output-barrel`
    //     closes that (realistic) regression vector. After Phases 5–6 a tool
    //     engine has ZERO production `@opensip-tools/output` imports, so a
    //     blanket barrel ban is exactly right.
    //
    // Production source only. Test files are excluded globally (options.exclude
    // drops `/__tests__/` + `*.test.*` before rules run), so graph's relocated
    // golden test that imports `formatSignalSarif` from @opensip-tools/output
    // does NOT trip these rules. The `pathNot` on `from` is belt-and-braces.
    // -------------------------------------------------------------------
    {
      name: 'tool-engines-no-output-formatters',
      severity: 'error',
      comment:
        'Tool engines (fitness/graph/simulation) must not import an ' +
        '@opensip-tools/output formatter. Tools emit a SignalEnvelope and ' +
        'return it; the CLI composition root chooses the formatter and ' +
        'renders. (ADR-0011.)',
      from: {
        path: '^packages/(fitness/engine|graph/engine|simulation/engine)/src/',
        pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`],
      },
      to: { path: '^packages/output/src/format/' },
    },
    {
      name: 'tool-engines-no-output-sinks',
      severity: 'error',
      comment:
        'Tool engines (fitness/graph/simulation) must not import an ' +
        '@opensip-tools/output sink. Cloud/file egress is resolved ONLY at ' +
        'the composition root (pre-action-hook for the sink; the render seam ' +
        'for --report-to). Tools never deliver. (ADR-0011.)',
      from: {
        path: '^packages/(fitness/engine|graph/engine|simulation/engine)/src/',
        pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`],
      },
      to: { path: '^packages/output/src/sink/' },
    },
    {
      name: 'tool-engines-no-output-barrel',
      severity: 'error',
      comment:
        'Tool engines (fitness/graph/simulation) must not import ' +
        '@opensip-tools/output at all for emission. The barrel resolves to ' +
        'output/src/index.ts (re-exporting both formatters and sinks), so the ' +
        'granular format/sink rules cannot see it; this catches that path. ' +
        'After Phases 5–6 a tool engine has zero production output imports — ' +
        'tools return a SignalEnvelope; the composition root renders/delivers. ' +
        '(ADR-0011.) Test files are excluded globally, so graph’s golden ' +
        'SARIF test may import formatSignalSarif from the barrel.',
      from: {
        path: '^packages/(fitness/engine|graph/engine|simulation/engine)/src/',
        pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`],
      },
      to: { path: String.raw`^packages/output/src/index\.ts$` },
    },

    // -------------------------------------------------------------------
    // ADR-0004 — OpenTelemetry SDK lives ONLY at the composition root.
    //
    // OTel is opt-in (gated on OTEL_EXPORTER_OTLP_ENDPOINT). `@opentelemetry/api`
    // (the no-op facade) is the only OTel dependency `core` and the tool
    // packages carry — surfaced through the `withSpan`/`getTracer` seam in core.
    // The heavy SDK (exporter, sdk-*, context manager, propagator, resources)
    // lives ONLY in `packages/cli`, the composition root, initialized from
    // bootstrapCli. ADR-0004's enforcement-reason states dependency-cruiser
    // confirms no `@opentelemetry/sdk-*` import leaks into core or any tool
    // package — this rule is that confirmation. It targets an EXTERNAL package
    // family, so it depends on the union `includeOnly` (see OTEL_SDK_FAMILY
    // note at the top of this file); without that surfacing it would cruise 0
    // dependencies and be inert.
    // -------------------------------------------------------------------
    {
      name: 'otel-sdk-only-in-cli',
      severity: 'error',
      comment:
        'The OpenTelemetry SDK family (@opentelemetry/sdk-*, exporter-*, ' +
        'context-*, propagator-*, resources) may be imported ONLY by ' +
        'packages/cli — the composition root that decides whether spans are ' +
        'exported. core and every tool depend on @opentelemetry/api (the no-op ' +
        'facade) only, through the withSpan/getTracer seam in core. An SDK ' +
        'import anywhere else inverts the library/application split. (ADR-0004.)',
      from: { path: '^packages/', pathNot: '^packages/cli/' },
      to: { path: OTEL_SDK_FAMILY },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — contracts depends only on core
    // -------------------------------------------------------------------
    {
      name: 'contracts-imports-core-only',
      severity: 'error',
      comment:
        'contracts holds the SignalEnvelope / CommandResult / exit code TYPES used ' +
        'by every tool. It must not import from any tool, the cli entry ' +
        'point, language packs, dashboard, or the runtime packages it was ' +
        'split into (datastore / session-store / output). It depends on ' +
        'core only (audit 2026-05-29, contracts split).',
      from: { path: '^packages/contracts/src/' },
      to: {
        path: [
          '^packages/cli/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/dashboard/',
          '^packages/datastore/',
          '^packages/session-store/',
          '^packages/output/',
          '^packages/config/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
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
          '^packages/cli/',
          '^packages/config/',
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
        ],
      },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — cli-ui has zero opensip-tools deps
    //
    // cli-ui is the shared Ink/React presentational layer (Banner, Spinner,
    // RunHeader, theme) used by every tool's live view + the CLI's static
    // render path. It must depend on nothing in the workspace — it's a
    // leaf package, equivalent in shape to a third-party UI library.
    // -------------------------------------------------------------------
    {
      name: 'cli-ui-no-workspace-deps',
      severity: 'error',
      comment:
        'cli-ui is a leaf package — Ink/React primitives only. It must not ' +
        'depend on any other @opensip-tools/* package. Other packages depend ' +
        'on it to share visual primitives across the CLI and tool live views.',
      from: { path: '^packages/cli-ui/src/' },
      // Resolved-path form: any workspace package EXCEPT cli-ui's own
      // source (a leaf importing its own files is fine; importing any
      // other package is the violation).
      to: { path: '^packages/', pathNot: '^packages/cli-ui/' },
    },

    // -------------------------------------------------------------------
    // Layer enforcement — cli/ui imports only contract types
    //
    // Layer 5 Phase 3 (audit 2026-05-22 F3): tool controllers (state
    // machine + executeFit/runGraph orchestration) moved out of
    // `packages/cli/src/ui/components/` into the tool packages. The
    // cli/ui layer is now a pure presentational layer driving static
    // command-result rendering through `App.tsx`. Pinning the import
    // boundary here prevents drift.
    // -------------------------------------------------------------------
    {
      name: 'cli-ui-no-tools',
      severity: 'error',
      comment:
        'cli/ui is the pure presentational layer for static CommandResult ' +
        'rendering. It must not import any tool, language, or check-pack ' +
        'package — tool-specific live views live in the tool packages and ' +
        'register themselves via cli.registerLiveView. Audit 2026-05-22 F3.',
      from: { path: '^packages/cli/src/ui/' },
      to: {
        path: [
          '^packages/fitness/engine/',
          '^packages/simulation/engine/',
          '^packages/graph/',
          '^packages/languages/lang-',
          '^packages/fitness/checks-',
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
      to: { path: '^packages/cli/' },
    },
    {
      name: 'simulation-no-cli',
      severity: 'error',
      comment:
        'Tool packages must not depend on the CLI entry point. Use the ' +
        'ToolCliContext from @opensip-tools/core to call back into render / ' +
        'maybeOpenDashboard.',
      from: { path: '^packages/simulation/' },
      to: { path: '^packages/cli/' },
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
        path: ['^packages/cli/', '^packages/contracts/'],
      },
    },
    // `check-pack-no-core-subpath` was retired here (gate-activation, 2026-05-30)
    // and reimplemented in eslint.config.mjs as a scoped `no-restricted-imports`
    // rule. Specifier-shape rules ("import from the barrel, not a subpath") are
    // ESLint's natural domain and don't depend on the depcruise resolver — and
    // depcruise can't reliably match `@opensip-tools/core/<subpath>` once it
    // resolves through `paths` to source (the `src/lib/...` layout differs from
    // the `core/<subpath>` specifier). Sanctioned subpaths remain
    // languages/* and test-utils/*.

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
          '^packages/cli/',
          '^packages/contracts/',
          '^packages/config/',
          '^packages/fitness/checks-',
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
      to: { path: '^packages/fitness/engine/' },
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
      to: { path: '^packages/cli/' },
    },
    {
      name: 'graph-no-check-packs',
      severity: 'error',
      comment: 'Graph sits in the tools/lang peer layer. It must not import any check pack.',
      from: { path: '^packages/graph/engine/src/' },
      to: { path: '^packages/fitness/checks-' },
    },
    {
      name: 'graph-rules-no-parser',
      severity: 'error',
      comment:
        'Rules consume frozen catalog/indexes only. They must not import any ' +
        'pipeline stage. (Adapter packs all live in their own packages now; ' +
        'the engine has no lang-* directory.)',
      from: { path: '^packages/graph/engine/src/rules/' },
      to: { path: '^packages/graph/engine/src/pipeline/' },
    },
    {
      name: 'graph-renderers-no-pipeline',
      severity: 'error',
      comment:
        'Renderers consume Signal[] and a RenderContext. They do not see the ' +
        'catalog or any rule logic.',
      from: { path: '^packages/graph/engine/src/render/' },
      to: { path: '^packages/graph/engine/src/(pipeline|rules)/' },
    },
    {
      // PR 1b of plan docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
      // The visitors/resolvers disjoint rules now police the relocated
      // graph-typescript package. Path globs repath to the new home.
      name: 'graph-visitors-resolvers-disjoint',
      severity: 'error',
      comment:
        'Inventory visitors handle declarations; edge resolvers handle call ' +
        'sites. They share helpers but not each other.',
      from: { path: '^packages/graph/graph-typescript/src/inventory-visitors/' },
      to: { path: '^packages/graph/graph-typescript/src/edge-resolvers/' },
    },
    {
      name: 'graph-resolvers-visitors-disjoint',
      severity: 'error',
      comment: 'Symmetric counterpart of graph-visitors-resolvers-disjoint.',
      from: { path: '^packages/graph/graph-typescript/src/edge-resolvers/' },
      to: { path: '^packages/graph/graph-typescript/src/inventory-visitors/' },
    },
    // PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md
    // deleted graph-pipeline-no-lang-import and
    // graph-orchestrate-no-direct-lang-import. With first-party adapter
    // subtrees relocated into their own packages, the
    // engine has no `engine/src/lang-*` directory to police; the
    // package-edge rule graph-engine-no-adapter-packs (below) takes
    // over and is strictly stronger because pnpm + the lockfile
    // enforce package edges by construction.
    {
      // Engine MUST NOT depend on adapter packs. Adapters depend on
      // the engine; the inverse would create an import cycle and
      // defeat the package split. Test files reach for the adapter
      // pack via @opensip-tools/graph-typescript at the test-file
      // level only — engine production source is exempt because tests
      // live in __tests__/ and devDeps don't satisfy this rule (engine
      // does NOT declare graph-typescript as a dependency or devDep).
      name: 'graph-engine-no-adapter-packs',
      severity: 'error',
      comment:
        'The engine package must not depend on any @opensip-tools/graph-* ' +
        'adapter pack. Adapters are downstream consumers; the engine ' +
        'discovers them via the registry walker, not import edges.',
      from: {
        path: '^packages/graph/engine/src/',
        pathNot: '^packages/graph/engine/src/__tests__/',
      },
      to: { path: '^packages/graph/graph-' },
    },
    {
      // PR 1b. Adapter packs MUST NOT depend on each other. Each pack
      // implements the contract for one language; cross-pack imports
      // would couple parser ecosystems together.
      //
      // Pattern-based (`graph-[a-z0-9-]+`) rather than a hand-listed set
      // of language names: every adapter package under packages/graph/
      // (graph-typescript|python|rust|go|java and any future pack) is
      // covered by construction. The engine package is named
      // `@opensip-tools/graph` (no hyphen suffix), so it never matches.
      // Audit 2026-05-29: graph-go / graph-java were added without being
      // listed in the prior name-pinned regex and silently escaped this
      // rule; pattern matching closes that class of drift permanently.
      name: 'graph-adapters-disjoint',
      severity: 'error',
      comment:
        'Graph adapter packs (@opensip-tools/graph-*) must not depend on ' +
        'each other from production source. Each pack implements the ' +
        'contract for one language. Test sources may consume sibling ' +
        'adapter packs as devDeps (multi-adapter contract / registry / ' +
        'pickAdapter coverage); production-source imports are forbidden.',
      from: {
        // Capture the source adapter package dir so `to.pathNot` can
        // exclude self-imports. In resolved-path form a flat
        // `^packages/graph/graph-` would match a pack's OWN files; the
        // backreference ($1) makes the rule fire only on a DIFFERENT
        // adapter pack.
        path: '^packages/graph/(graph-[a-z0-9-]+)/src/',
        pathNot: '^packages/graph/graph-[a-z0-9-]+/src/__tests__/',
      },
      to: {
        path: '^packages/graph/graph-[a-z0-9-]+/',
        // Exclude self-imports ($1) AND the sanctioned shared scaffolding
        // package. graph-adapter-common is named `graph-adapter-common`
        // so it matches the `graph-[a-z0-9-]+` pattern, but it is the one
        // well-known upstream every tree-sitter adapter is *meant* to
        // consume (engine → graph-adapter-common → adapters). The disjoint
        // rule's intent is "adapters don't couple to each other's LANGUAGE
        // code"; importing the shared scaffolding layer doesn't violate
        // that, so it is carved out precisely (DEC-1 / DEC-8). The
        // back-edge (common → a specific adapter) is forbidden separately
        // by `graph-common-no-adapters` below.
        pathNot: ['^packages/graph/$1/', '^packages/graph/graph-adapter-common/'],
      },
    },
    {
      // Shared-scaffolding layering guard (DEC-8 #2). The common package
      // is the upstream every tree-sitter adapter consumes; it must NEVER
      // reach back DOWN into a specific language adapter (that would invert
      // the engine → common → adapters layering and re-couple the
      // ecosystems the disjoint rule keeps apart). It may depend only on
      // the engine (`@opensip-tools/graph`, no hyphen suffix → does not
      // match `graph-[a-z0-9-]+`), core, glob, and tree-sitter.
      name: 'graph-common-no-adapters',
      severity: 'error',
      comment:
        '@opensip-tools/graph-adapter-common must not import any ' +
        'graph-* adapter pack. It is upstream of the adapters (engine → ' +
        'common → adapters); a back-edge would invert the layering.',
      from: { path: '^packages/graph/graph-adapter-common/src/' },
      to: {
        path: '^packages/graph/graph-[a-z0-9-]+/',
        // Relative self-imports (./parse.js → src/parse.ts) match the
        // graph-* pattern too; exclude the package's own tree.
        pathNot: '^packages/graph/graph-adapter-common/',
      },
    },
    {
      // PR 1b. Adapter packs MUST NOT depend on the CLI. Pattern-based:
      // covers every graph-* adapter pack, incl. go/java (audit 2026-05-29).
      name: 'graph-adapters-no-cli',
      severity: 'error',
      comment: 'Graph adapter packs must not depend on opensip-tools.',
      from: { path: '^packages/graph/graph-[a-z0-9-]+/' },
      to: { path: '^packages/cli/' },
    },
    {
      // PR 1b. Adapter packs MUST NOT depend on fitness or check packs.
      // Pattern-based: covers every graph-* adapter pack, incl. go/java
      // (audit 2026-05-29).
      name: 'graph-adapters-no-fitness-or-checks',
      severity: 'error',
      comment:
        'Graph adapter packs must not depend on @opensip-tools/fitness or ' +
        'any @opensip-tools/checks-* package — peer-layer isolation.',
      from: { path: '^packages/graph/graph-[a-z0-9-]+/' },
      to: { path: '^packages/fitness/(engine|checks-)' },
    },
    // PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md
    // deleted graph-no-tree-sitter-import-outside-lang-packs. The
    // engine no longer declares tree-sitter as a runtime dependency,
    // so there is nothing for any engine/src/* file to import.
    // tree-sitter ships only through adapter/substrate packages, where it
    // belongs.
    //
    // ADR-0010 restored: that deletion removed the ENGINE-scoped guard, but the
    // ADR's enforcement-reason requires the broader invariant — construction of
    // a tree-sitter Parser (i.e. importing web-tree-sitter) is restricted to the
    // lang-* packages and the @opensip-tools/tree-sitter substrate; every other
    // package — including the graph adapters and graph-adapter-common — must
    // obtain parsed trees by importing @opensip-tools/lang-*. The rule below is
    // that platform-wide guard. It targets an EXTERNAL package, so it depends on
    // the union includeOnly (see TREE_SITTER_PARSER note at the top of this
    // file); the graph adapters reference "web-tree-sitter" only in code
    // comments today, so the clean tree stays at 0 violations.
    {
      name: 'tree-sitter-parser-only-in-lang-packs',
      severity: 'error',
      comment:
        'web-tree-sitter (the tree-sitter Parser substrate) may be imported ' +
        'ONLY by @opensip-tools/tree-sitter (the grammar-agnostic substrate) ' +
        'and the @opensip-tools/lang-* adapters. Every other package — ' +
        'including the graph adapters and graph-adapter-common — must obtain ' +
        'parsed trees via @opensip-tools/lang-*, the single canonical parse ' +
        'substrate. Constructing a Parser elsewhere duplicates parsing and ' +
        'double-parses files. (ADR-0010.)',
      from: {
        path: '^packages/',
        pathNot: ['^packages/tree-sitter/', '^packages/languages/lang-'],
      },
      to: { path: TREE_SITTER_PARSER },
    },
    {
      // Audit 2026-05-29 (M1): the prior `graph-may-import-fitness-sarif`
      // info-exception is gone. The only real graph→fitness edge was
      // `reportToCloud`; SARIF formatting and cloud delivery moved to
      // @opensip-tools/output and are applied at the CLI composition root,
      // so graph and fitness have no peer cycle. Graph must now NOT import fitness at all — there
      // is no sanctioned exception. (Breaking this cycle is what lets
      // fitness read graph's catalog via CatalogRepo instead of raw SQL;
      // see H1.) Production source only; test files may use devDeps.
      name: 'graph-no-fitness',
      severity: 'error',
      comment:
        'Graph must not import @opensip-tools/fitness. The former SARIF / ' +
        'reportToCloud edge was removed by relocating output formatting ' +
        'and delivery to @opensip-tools/output (audit 2026-05-29, M1).',
      from: {
        path: '^packages/graph/',
        pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`],
      },
      to: { path: '^packages/fitness/engine/' },
    },
    {
      // Audit 2026-05-29 (L2): fitness and graph are now fully decoupled.
      // The former sole sanctioned fitness→graph edge (the dashboard
      // command reading graph's CatalogRepo) is gone — the CLI is now the
      // dashboard composition root and each tool contributes its OWN
      // dashboard data via `collectDashboardData`. Graph returns its
      // `graphCatalog`; fitness returns its catalogs; neither reaches
      // into the other. This rule is now strict (no exception).
      // `@opensip-tools/graph($|/)` matches the engine only, not the
      // graph-* adapter packs.
      name: 'fitness-no-graph',
      severity: 'error',
      comment:
        'fitness must not import @opensip-tools/graph. Cross-tool ' +
        'dashboard composition is owned by the CLI; each tool contributes ' +
        'its own dashboard data via the Tool.collectDashboardData seam.',
      from: {
        path: '^packages/fitness/',
        pathNot: ['/__tests__/', String.raw`\.test\.(ts|tsx)$`],
      },
      to: { path: '^packages/graph/engine/' },
    },

    // -------------------------------------------------------------------
    // graph dashboard — Code Paths panel architectural invariants. The
    // catalog-decoupling rule (dashboard consumes the graph catalog by JSON
    // shape only, never importing @opensip-tools/graph) is documented in
    // docs/plans/ready/graph-visualizer-view/. The panel lives in
    // @opensip-tools/dashboard. Each rule below codifies a single
    // architectural-invariant claim.
    // -------------------------------------------------------------------
    {
      name: 'dashboard-no-graph-import',
      severity: 'error',
      comment:
        'AI-3: dashboard code-paths must not import @opensip-tools/graph; ' +
        'consume the catalog by JSON shape only.',
      from: { path: '^packages/dashboard/src/code-paths' },
      to: { path: '^packages/graph/engine/' },
    },
    {
      name: 'dashboard-code-paths-self-contained',
      severity: 'error',
      comment:
        'MI-1: code-paths/* may import only from @opensip-tools/contracts ' +
        '(for GraphCatalog types), @opensip-tools/core, dashboard siblings, ' +
        'and Node built-ins. No other cross-package imports.',
      from: { path: '^packages/dashboard/src/code-paths/' },
      // Resolved-path form: any workspace package EXCEPT contracts, core,
      // and dashboard's own source (siblings). Node built-ins never match
      // `^packages/`, so they're implicitly allowed.
      to: {
        path: '^packages/(?!(contracts|core|dashboard)/)',
      },
    },
    {
      name: 'dashboard-views-disjoint',
      severity: 'error',
      comment:
        'MI-2: code-paths/view-*.ts files must not import each other. They ' +
        'share state through views-registry, filterState, and indexes only. ' +
        'view-template.ts is the one exception — it is the rank-and-render ' +
        'helper consumed by the four ranked views (hot/big/wide/untested) ' +
        'and contains no view registration of its own.',
      from: {
        path: '^packages/dashboard/src/code-paths/view-',
        pathNot: String.raw`^packages/dashboard/src/code-paths/view-template\.ts$`,
      },
      to: {
        path: '^packages/dashboard/src/code-paths/view-',
        pathNot: String.raw`^packages/dashboard/src/code-paths/view-template\.ts$`,
      },
    },
    {
      name: 'dashboard-algorithms-no-view-deps',
      severity: 'error',
      comment:
        'MI-3: pure-algorithm modules (scc, search, trace) must not import ' +
        'view files or function-card.',
      from: { path: String.raw`^packages/dashboard/src/code-paths/(scc|search|trace)\.ts$` },
      to: { path: String.raw`^packages/dashboard/src/code-paths/(view-|function-card\.ts)` },
    },
    {
      name: 'dashboard-no-side-stylesheets',
      severity: 'error',
      comment:
        'AI-4: new CSS must extend dashboard/css.ts. No external .css imports ' +
        'inside the dashboard package.',
      from: { path: '^packages/dashboard/src/' },
      to: { path: String.raw`\.css$` },
    },
    {
      name: 'dashboard-no-ui-framework',
      severity: 'error',
      comment: 'AI-2: dashboard must not depend on any UI framework or visualization library.',
      from: { path: '^packages/dashboard/src/' },
      to: {
        path: '^(react|preact|vue|svelte|@?solidjs|d3|d3-.+|three|cytoscape|sigma|vis-network|@?angular)(/|$)',
      },
    },
  ],

  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', String.raw`\.turbo`],
    },

    // Treat workspace package names as workspace-internal (not 'npm') so the
    // forbidden rules can match by package path.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
    },

    tsConfig: {
      // depcruise-only tsconfig: extends the root config but adds `paths`
      // mapping every @opensip-tools/* specifier to its package SOURCE
      // (packages/*/src/index.ts). Without this, workspace imports resolve
      // via each package's `exports` to dist/, which exclude + includeOnly
      // below then drop — making every cross-package layer rule inert
      // (the whole point of this gate). NOT used for tsc builds.
      //
      // Absolute path (via __dirname) is deliberate: dependency-cruiser passes
      // TypeScript both a basePath of this file's dir AND the relative
      // configFileName, which double-counts the `.config/` segment and breaks
      // the relative `extends: ../tsconfig.json` resolution. An absolute
      // fileName wins TS's path-combine and sidesteps the double-count.
      fileName: require('node:path').resolve(__dirname, 'tsconfig.depcruise.json'),
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

    // Union: workspace source PLUS the two external families the ADR-0004 /
    // ADR-0010 guards target (OTel SDK + web-tree-sitter). A bare '^packages/'
    // drops every node_modules edge before rules run, which would make those
    // two npm-targeting rules structurally inert. Surfacing ONLY these two
    // families keeps every other node_modules edge dropped (so no other rule's
    // inertness assumption changes) while letting the two guards fire. See the
    // OTEL_SDK_FAMILY / TREE_SITTER_PARSER notes at the top of this file.
    includeOnly: ['^packages/', OTEL_SDK_FAMILY, TREE_SITTER_PARSER],
    exclude: {
      path: [
        '^packages/[^/]+/[^/]+/dist/',
        '^packages/[^/]+/dist/',
        String.raw`\.test\.(ts|tsx)$`,
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
