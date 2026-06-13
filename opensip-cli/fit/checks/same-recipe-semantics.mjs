/**
 * @fileoverview same-recipe-semantics — recipe execution must run on the shared
 *               substrate (§5.8 / §4.3). Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-universal` (placement sweep) because it
 * encodes opensip-cli local facts: it hardcodes opensip-cli' OWN first-party
 * recipe-execution paths (`packages/(fitness|simulation)/engine/src/recipes/`),
 * the shared substrate's `runWithTimeout` / `scheduleUnits` / `executePipeline`
 * seam in `@opensip-cli/core`, and the §5.8/§4.3 "same words, same semantics"
 * convergence plus the ADR-0026 graph exemption. A consumer repo has none of
 * those paths or that substrate, so the rule is opensip-internal, not universal.
 * Inert for adopters per opensip-cli/fit/checks/README.md.
 *
 * Release 2.13.0 hoisted one execution substrate (`scheduleUnits` + `runWithTimeout`,
 * `@opensip-cli/core`) that fit + sim recipes run on, so `timeout` / `maxParallel`
 * / `stopOnFirstFailure` mean the same thing in every domain — the "same words, same
 * semantics" guarantee. A recipe engine that reimplements the per-unit timeout with a
 * local `setTimeout(...)` around the run re-creates the exact divergence (§4.3) the
 * substrate removed — a `timeout` that means something different per tool, or, as
 * sim's `runSingle` proved, silently nothing.
 *
 * This check flags a raw `setTimeout(` inside the fitness/simulation recipe-execution
 * sources — the per-unit timeout MUST come from the substrate's `runWithTimeout`.
 * Graph is exempt by ADR-0026 (selection-only execution — it has no `execution`
 * block to schedule). `strip-strings-and-comments`; tests are exempt.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Fitness + simulation recipe-execution sources (graph is selection-only, ADR-0026). */
const RECIPE_EXEC_PATH = /packages\/(?:fitness|simulation)\/engine\/src\/recipes\//;

const TEST_PATH = /\.test\.tsx?$|\/__tests__\//;

/** A raw timer install — the per-unit timeout reimplementation the substrate replaced. */
const SET_TIMEOUT_RE = /\bsetTimeout\s*\(/;

/** Pure analysis. Exported for unit tests. */
export function analyzeSameRecipeSemantics(content) {
  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (SET_TIMEOUT_RE.test(line)) {
      violations.push({
        message:
          'Recipe execution must run on the shared substrate (§5.8): a per-unit timeout ' +
          'comes from runWithTimeout, not a local setTimeout — so timeout/parallel/stop ' +
          'mean the same thing in fit and sim (the §4.3 "same semantics" guarantee).',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Route the unit run through runWithTimeout / scheduleUnits / executePipeline ' +
          '(@opensip-cli/core), or — for a deliberate per-domain difference — document it ' +
          'in an ADR (the same-recipe-semantics exception, e.g. ADR-0026 for graph).',
      });
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'e24d2dce-cd2a-40d7-9fe9-955023888929',
    slug: 'same-recipe-semantics',
    description:
      'Recipe execution must run on the shared substrate; no per-tool scheduler reimplementation (§5.8/§4.3)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => {
      if (!RECIPE_EXEC_PATH.test(filePath) || TEST_PATH.test(filePath)) return [];
      return analyzeSameRecipeSemantics(content);
    },
  }),
];
