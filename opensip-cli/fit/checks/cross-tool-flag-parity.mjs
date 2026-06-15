/**
 * @fileoverview cross-tool-flag-parity — cross-tool common CLI flags must come
 *               from the shared registry, not be hand-declared. Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-universal` (placement sweep) because it
 * encodes opensip-cli local facts: it hardcodes the first-party tool-registration
 * paths (`packages/{fitness,graph,simulation}/engine/src/tool.ts`), the ADR-0021
 * `commonFlags` registry seam in `@opensip-cli/contracts`, and the exact
 * registry-owned long-flag set (`--json`, `--cwd`, `--quiet`, `--verbose`,
 * `--debug`, `--report-to`, `--api-key`, `--open`). A consumer repo whose
 * Commander CLI legitimately declares `--json` etc. does not share that
 * architecture, so the rule is opensip-internal, not universal. Inert for
 * adopters per opensip-cli/fit/checks/README.md.
 *
 * WHY (ADR-0021, "cross-tool CLI flag currency"): the flags every tool's run
 * command shares are declared ONCE in `@opensip-cli/contracts` (`commonFlags`)
 * and applied via `applyCommonFlags`. Hand-declaring one with a raw
 * `.option('--json', ...)` in a tool registration file reintroduces the
 * per-tool duplication that already drifted (`--report-to` read three different
 * ways before the registry). This check fires on that raw declaration so the
 * parity cannot silently regress.
 *
 * Positive parity — that each run command actually DECLARES the mandatory set —
 * is asserted by the per-tool flag-surface contract tests
 * (`tool-flag-surface.test.ts`, `sim-capability-contract.test.ts`). This check
 * is the complementary "don't hand-declare a common flag" guard.
 *
 * SCOPE — opensip-cli's own tool registration files only
 * (`packages/{fitness,graph,simulation}/engine/src/tool.ts`). The path guard
 * makes it inert in adopter repos — it enforces THIS platform's architecture,
 * not a universal rule.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Resolved-path fragment identifying a first-party tool registration file. */
const TOOL_REGISTRATION_PATH = /packages\/(?:fitness|graph|simulation)\/engine\/src\/tool\.ts$/;

/** Long flags owned by the ADR-0021 registry — a raw `.option(...)` for any of
 *  these bypasses `applyCommonFlags`. */
const REGISTRY_LONG_FLAGS = new Set([
  '--json',
  '--cwd',
  '--quiet',
  '--verbose',
  '--debug',
  '--report-to',
  '--api-key',
  '--open',
]);

/** Captures the first string argument of a `.option(...)` call (the flag spec). */
const OPTION_LITERAL_RE = /\.option\(\s*['"]([^'"]+)['"]/;

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * without the full Check framework. Flags each `.option('<common-flag>', ...)`
 * whose long flag is registry-owned.
 */
export function analyzeCrossToolFlagParity(content) {
  const violations = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    const match = OPTION_LITERAL_RE.exec(line);
    if (!match) continue;
    const longFlag = /--[a-z][a-z-]*/.exec(match[1])?.[0];
    if (longFlag === undefined || !REGISTRY_LONG_FLAGS.has(longFlag)) continue;
    violations.push({
      message: `Common flag '${longFlag}' is hand-declared via .option(...); cross-tool flags must come from the shared registry (ADR-0021).`,
      severity: 'error',
      line: i + 1,
      suggestion: `Apply it via applyCommonFlags(cmd, [...keys]) from @opensip-cli/contracts instead of a raw .option('${longFlag}' ...).`,
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '534bf31f-41a2-4bec-b0a7-c08205770db1',
    slug: 'cross-tool-flag-parity',
    description:
      'Cross-tool common CLI flags must come from the shared registry, not be hand-declared (ADR-0021)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    // raw content: the flag specs we detect ARE string literals, so they must not
    // be stripped. The regex requires `.option(` immediately before the literal,
    // so prose mentioning a flag does not false-fire.
    contentFilter: 'raw',
    analyze: (content, filePath) => {
      if (!TOOL_REGISTRATION_PATH.test(filePath)) return [];
      return analyzeCrossToolFlagParity(content);
    },
  }),
];
