/**
 * graph-list command — list all available graph rules
 * (tool-command-surface-taxonomy Task 3.4).
 *
 * The natural analog of fitness's `listChecks` (`cli/fit-list.ts`): graph
 * *rules* (large-function, cycle, orphan-subtree, …) are the listable unit, the
 * counterpart of fitness *checks*. This maps the scope-bound rule registry to
 * the shared `ListChecksResult` contract so the existing CLI renderer
 * (`viewListChecks`) handles the output with no new view — the same shape +
 * renderer reuse that `graph-recipes` uses for `ListRecipesResult`.
 *
 * `title` is supplied so the shared renderer reads "Available Graph Rules"
 * rather than the fitness default. The rule has no free-form description today,
 * so its `defaultSeverity` is surfaced both as the description text and as the
 * grouping tag (the renderer groups by tag).
 *
 * Reads `currentRules()` (a cheap, scope-only read — the registry is seeded at
 * construction, no engine run), so it runs inside the entered RunScope (the
 * command action body does).
 */

import { currentRules } from '../rules/registry.js';

import type { ListChecksResult } from '@opensip-cli/contracts';

/**
 * Returns metadata for every registered graph rule, shaped as the shared
 * `ListChecksResult`. Synchronous (the rule registry is scope-seeded at
 * construction), but returns a `Promise` to mirror fitness's `listChecks`
 * signature so the `command-result` handler reads identically across tools.
 */
export function listGraphRules(): Promise<ListChecksResult> {
  const rules = currentRules();

  const checks = rules.map((rule) => ({
    slug: rule.slug,
    // Rules carry no free-form description today; surface their default
    // severity as the descriptive text (the richer display lands with Plan D).
    description: `${rule.defaultSeverity}-level graph rule`,
    tags: [rule.defaultSeverity],
  }));

  return Promise.resolve({
    type: 'list-checks',
    title: 'Available Graph Rules',
    checks,
    totalCount: checks.length,
  });
}
