/**
 * @fileoverview no-bare-error-throw — a `throw new Error(...)` in a package whose
 *   error-classification migration is COMPLETE. Project-local SELF-check.
 *
 * WHY this lives HERE (project-local .mjs), not in a shipped @opensip-cli/checks-*
 * pack: it hardcodes first-party package paths (which of OUR packages have been
 * migrated), so per `opensip-cli/fit/checks/README.md` and the
 * `shipped-checks-must-be-generic` placement gate it must NOT ship — it is inert
 * for any adopter who installs opensip-cli and runs `fit` on their own code. It is
 * a pure text/regex check with no AST need, so there is no honest reason to ship it.
 *
 * WHAT IT ENFORCES
 * A bare `Error` carries no machine identity. It normalizes to `SYSTEM_ERROR`, whose
 * exposure is `redacted`, so the public projection replaces the message with
 * "The operation failed." Every such site is a diagnosis the CLI computed and then
 * threw away — including, before Plan 01, refusals that named the exact fix.
 *
 * WHY THE SHIPPED SIBLING IS NOT ENOUGH
 * `error-code-registration` matches code LITERALS (`ABC.DEF.GHI`) and asks whether
 * they are registered. A bare `Error` contains no code literal, so that check cannot
 * see one. The two are complementary: it asks "is this code registered?", this asks
 * "should this site have had a code at all?" Without this check, `fit` reported
 * PASS 0/0 across the whole migration while 206 unmigrated sites sat in the tree.
 *
 * HOW IT RATCHETS
 * Enforcement is scoped to MIGRATED_PACKAGES below. A package joins that list in the
 * same change that migrates it, so the list only ever grows and growing it is a
 * one-line diff reviewed next to the work that earned it. This makes finished work
 * stay finished without making the backlog invisible — the remaining packages are
 * exactly the ones absent from the list.
 *
 * Pointing it at the whole repo today would fire on the unmigrated backlog, and this
 * repo runs a deliberate zero-warning gate. That leaves only two dishonest options —
 * disable the check, or weaken the gate — so it enforces the ground already taken.
 *
 * contentFilter is `strip-strings-and-comments`: the engine masks both, so prose in
 * this file's own doc comment and any `throw new Error(` inside a string literal are
 * inert. The check would otherwise flag its own documentation.
 */

import { defineCheck } from '@opensip-cli/fitness';

/** A `throw new Error(...)` with no registered definition behind it. */
const BARE_ERROR_THROW = /\bthrow\s+new\s+Error\s*\(/gu;

/**
 * Packages whose error-classification migration is complete (Plan 01).
 *
 * `packages/languages/` covers every language adapter without naming each one.
 */
const MIGRATED_PACKAGES = [
  'packages/cli-live/',
  'packages/cli-ui/',
  'packages/codebase/',
  'packages/config/',
  'packages/contracts/',
  'packages/core/',
  'packages/dashboard/',
  'packages/datastore/',
  'packages/external-tool-adapter/',
  // Engine only — check packs and graph language adapters are Wave 4.
  'packages/fitness/engine/',
  'packages/format/',
  'packages/graph/engine/',
  'packages/languages/',
  'packages/mcp/',
  'packages/output/',
  'packages/session-store/',
  'packages/shared-analysis/',
  'packages/simulation/engine/',
  'packages/targeting/',
  'packages/tool-test-kit/',
  'packages/tree-sitter/',
  'packages/yagni/engine/',
];

/** Tests construct unclassified failures on purpose — that is what they are proving. */
const NON_SOURCE = /(?:__tests__|__fixtures__|\.test\.ts|\/test-utils\/|\/dist\/)/u;

/**
 * Flag every bare `throw new Error(` in a migrated package's production source.
 *
 * @param {string} content File content, strings and comments already masked by the engine.
 * @param {string} filePath Absolute or repo-relative path of the file.
 * @returns {Array<object>} One violation per occurrence.
 */
export function analyzeNoBareErrorThrow(content, filePath) {
  const norm = String(filePath).replaceAll('\\', '/');
  if (NON_SOURCE.test(norm)) return [];
  if (!MIGRATED_PACKAGES.some((pkg) => norm.includes(pkg))) return [];

  const violations = [];
  BARE_ERROR_THROW.lastIndex = 0;
  let match;
  while ((match = BARE_ERROR_THROW.exec(content)) !== null) {
    violations.push({
      line: content.slice(0, match.index).split('\n').length,
      column: 0,
      message:
        'Bare `throw new Error(...)` in a migrated package — this reaches the user as "The operation failed."',
      severity: 'error',
      suggestion:
        'Raise a registered error definition instead, usually through the failure funnel this module already has. Where several sites share one operator action, share the code and name the branch in allowlisted `metadata.condition`.',
      match: match[0],
    });
  }
  return violations;
}

export const noBareErrorThrow = defineCheck({
  id: 'b2f4c7a1-9d3e-4c58-8a16-1e7f05c9d243',
  slug: 'no-bare-error-throw',
  description:
    'A bare `throw new Error(...)` in a package whose error-classification migration is complete',
  scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
  tags: ['errors', 'resilience', 'architecture'],
  contentFilter: 'strip-strings-and-comments',
  analyze: analyzeNoBareErrorThrow,
});
