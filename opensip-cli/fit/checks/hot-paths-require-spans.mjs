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
 * lang-* parsers for a universal architecture rule. It errs on the side of
 * loudness for engine code and provides clear `@fitness-ignore-file` escape.
 */

import { defineCheck } from '@opensip-cli/fitness';

const HOT_IMPORTS = [
  /from ['"]@opensip-cli\/fitness['"]/,
  /from ['"]@opensip-cli\/graph['"]/,
  /from ['"]@opensip-cli\/simulation['"]/,
  /from ['"]@opensip-cli\/lang-(typescript|rust|python|go|java|cpp)['"]/,
  /from ['"].*\/(fitness|graph|simulation)\/engine['"]/,
];

const HAS_SPAN = /withSpan(Async)?\s*\(/;

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeHotPathsRequireSpans(content, filePath) {
  const violations = [];

  const importsHot = HOT_IMPORTS.some((re) => re.test(content));
  if (!importsHot) return violations;

  // Allow test files and the telemetry seam itself
  if (
    /__tests__|test-support|telemetry\.ts|profiling\.ts/.test(filePath) ||
    /@fitness-ignore-file.*(needs-telemetry|hot-paths)/.test(content)
  ) {
    return violations;
  }

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
