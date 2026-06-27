/**
 * @fileoverview hot-paths-require-spans — engine hot paths must be wrapped in
 *               withSpan / withSpanAsync for observability. Project-local SELF-check.
// @fitness-ignore-file hot-paths-require-spans -- This is the guardrail check itself; it defines the rule, does not execute hot paths.
 *
 * Relocated out of `@opensip-cli/checks-*` (placement sweep) because it encodes
 * opensip-cli local facts: it hardcodes opensip-cli' OWN first-party package
 * names (`@opensip-cli/fitness`, `@opensip-cli/graph`, `@opensip-cli/simulation`,
 * the `@opensip-cli/lang-*` adapters, and the `fitness|graph|simulation/engine`
 * paths), the internal `withSpan/withSpanAsync` telemetry seam, and the
 * `telemetry.ts`/`profiling.ts` seam files — none of which a consumer repo has.
 * It also cites ADR-0049 / the observability-hardening plan (Phase 4A). Inert
 * for adopters per opensip-cli/fit/checks/README.md.
 *
 * This is the aggressive mechanized guardrail from the observability-hardening
 * plan (Phase 4A). New expensive work in fitness, graph, simulation, or language
 * adapters must be instrumented so that traces/metrics/profiles can attribute
 * time and cost.
 *
 * The check is intentionally simple (text/regex over AST) to avoid pulling in
 * lang-* parsers for a universal architecture rule. It is scoped to engine /
 * adapter IMPLEMENTATION files that do RUNTIME first-party work. It deliberately
 * skips, as NON-hot-paths: check-* packs (their execution is traced once,
 * centrally, by the engine runner — `run-one-check` withSpanAsync — so a per-check
 * span is redundant nesting; the file only imports the `defineCheck` API), the
 * cli dispatcher/wiring layer, barrels (`index.ts`), type modules (`*types.ts`),
 * display maps, scaffolds (run once at `init`), and type-only imports (erased at
 * runtime). A clear `@fitness-ignore-file` escape remains for genuine exceptions.
 *
 * It ALSO skips the graph language-ADAPTER packages (`graph/graph-<lang>/src/`
 * and `graph/graph-adapter-common/src/`) for the SAME reason check-* packs are
 * skipped: the graph engine owns the span boundary and traces adapter work once,
 * centrally, per pipeline stage. Every production path wraps the adapter calls
 * (`discoverFiles`/`parseProject`/`walkProject`/`resolveCallSites`) in a
 * `withSpanAsync('opensip_cli.graph.<stage>')` span:
 *   - exact engine — `cli/orchestrate.ts` + `orchestrate/catalog-builder.ts`
 *     run each stage through `runStage` (→ withSpanAsync);
 *   - sharded engine (the default) — `orchestrate/sharded-graph.ts` opens a
 *     `sharded_build` parent span and the per-shard workers
 *     (`cli/shard-worker.ts` → `buildAndResolveCatalog` with `spanRunStage`)
 *     emit per-stage spans that nest under it via TRACEPARENT;
 *   - background worker — `cli/graph-worker.ts` re-runs `runGraph` (exact path).
 * The adapters are pure transforms the engine INVOKES inside those stage spans;
 * a per-adapter-file span would be redundant nesting that adds no attribution
 * (the stage span already attributes the time) AND would wrongly couple a
 * pluggable adapter to the engine's tracer. The engine itself
 * (`graph/engine/src/`) is NOT exempt — genuinely uninstrumented hot work there
 * is still a real finding.
 */

import { defineCheck } from '@opensip-cli/fitness';

// First-party packages whose RUNTIME (value) import marks engine hot-path work.
// `graph-adapter-common` is the shared discover/parse/walk/resolve scaffolding the
// language graph adapters call at runtime — as load-bearing as `graph/engine`.
const HOT_IMPORTS = [
  /from ['"]@opensip-cli\/fitness['"]/,
  /from ['"]@opensip-cli\/graph(-adapter-common)?['"]/,
  /from ['"]@opensip-cli\/simulation['"]/,
  /from ['"]@opensip-cli\/yagni['"]/,
  /from ['"]@opensip-cli\/lang-(typescript|rust|python|go|java|cpp)['"]/,
  /from ['"].*\/(fitness|graph|simulation|yagni)\/engine['"]/,
];

const HAS_SPAN = /withSpan(Async)?\s*\(/;

// `import type … from '…'` is erased at runtime, so it is NOT a hot-path use.
// Stripped before the HOT_IMPORTS test so type-only consumers do not false-fire.
const TYPE_ONLY_IMPORT = /import\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?/g;

// Paths that import first-party code but are NOT engine hot paths — see file header.
// `\/graph\/graph-[a-z-]+\/src\/` matches the graph language-adapter packages
// (graph-go|java|python|rust|typescript, graph-adapter-common) but NOT the engine
// (`graph/engine/src/`): adapter work is traced centrally by the engine's
// per-stage spans, so a per-adapter span is redundant nesting (see file header).
const NOT_HOT_PATH =
  /\/checks-[a-z]+\/src\/|\/cli\/src\/|\/graph\/graph-[a-z-]+\/src\/|\/index\.ts$|[/.-]types\.ts$|\/display\/|\/scaffold\/|__tests__|test-support|telemetry\.ts|profiling\.ts/;

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeHotPathsRequireSpans(content, filePath) {
  const violations = [];
  const path = filePath.replaceAll('\\', '/');

  // Only engine/adapter IMPLEMENTATION files are hot paths; skip the rest.
  if (NOT_HOT_PATH.test(path)) return violations;
  if (/@fitness-ignore-file.*(needs-telemetry|hot-paths)/.test(content)) return violations;

  // A type-only import of first-party code carries no runtime work.
  const runtime = content.replace(TYPE_ONLY_IMPORT, '');
  if (!HOT_IMPORTS.some((re) => re.test(runtime))) return violations;

  if (!HAS_SPAN.test(content)) {
    violations.push({
      message:
        'File imports engine hot-path code but does not appear to wrap work in withSpan/withSpanAsync. Add instrumentation (or add @fitness-ignore-file hot-paths-require-spans with justification).',
      line: 1,
      column: 1,
    });
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    slug: 'hot-paths-require-spans',
    description:
      'Engine hot paths (fitness checks, graph stages, language adapters, simulation) must be wrapped with withSpan/withSpanAsync for observability. See ADR-0049 and the observability plan.',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['observability', 'architecture'],
    analyze: (content, filePath) => analyzeHotPathsRequireSpans(content, filePath),
  }),
];
