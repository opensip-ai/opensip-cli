# Project-local fitness checks for opensip-cli

`.js` and `.mjs` files in this directory and its subdirectories hold
**project-local** fit checks that the opensip-cli repo uses to analyze itself.
They are auto-discovered by the plugin loader (see
`packages/core/src/plugins/discover.ts`) and run as part of every
`pnpm fit` invocation against this repo.

## Dual purpose

These checks serve two audiences:

1. **Enforcement for this codebase.** Each check encodes a convention
   we care about — committed `it.only`, raw `console.log` in
   production, etc.
2. **Documentation-by-example for plugin authors.** opensip-cli
   is open-source. Anyone evaluating it or learning to author their
   own checks can read these files top-to-bottom to see how
   `defineCheck` is actually used in practice. We deliberately
   author these checks to be **readable** — small files, lots of
   explanatory comments, no clever abstractions.

## Conventions for new project-local checks

- **File shape:** ES modules with `.mjs` extension. The plugin
  loader auto-discovers `.js` and `.mjs` files recursively under this
  directory (not `.ts`). Subdirectories are allowed for local organization;
  discovery namespaces include the relative path.
- **Supported exports:** prefer `export const checks = [defineCheck({...})]`
  for dogfood files that may grow to multiple rules. The loader also accepts
  named `defineCheck(...)` exports and a default single-check export. See
  `packages/fitness/engine/src/plugins/loader.ts` for registration semantics
  and `packages/core/src/plugins/__tests__/discover.test.ts` for loose-file
  discovery.
- **Imports:** `import { defineCheck, isTestFile, ... } from '@opensip-cli/fitness'`.
  Resolves via workspace linkage in this monorepo and via the
  published package in any other consumer.
- **ID:** every check needs a stable, unique `id` field. For local-only
  dogfood checks, use a readable `local:<area>-<slug>` id and do not change
  it after the check has run in baselines. For promoted or shipped checks,
  follow the first-party pack convention in the destination package.
- **Comments:** prioritize "why this shape" over "what this code
  does." A reader landing here is learning the pattern, not
  reviewing the implementation.
- **Tests:** project-local checks don't get a per-file Vitest
  config. Coverage comes from the dogfood `pnpm fit:ci` gate, which
  auto-loads these files through the project-local plugin path.
- **Slug naming:** project-local checks that demonstrate patterns also
  shipped as first-party (e.g. `no-focused-tests`, `no-console-log`
  exist in `@opensip-cli/checks-universal`) must use a distinct
  slug — prefix with `dogfood-` so they don't shadow the shipped
  versions in the registry.

## ADR dogfood guardrails

The `adr-*.mjs` files hold opensip-cli-specific checks derived from
`docs/decisions`. They intentionally encode local facts such as workflow
names, first-party package names, manifest marker kinds, and known
migration bridge files. Keep them here rather than in the shipped
`packages/fitness/checks-*` packs, unless the rule is rewritten to apply
cleanly to arbitrary customer codebases.

The older `env-via-registry.mjs` and `no-local-exit-or-stdout.mjs`
remain separate because they were previously promoted and then pulled
back from shipped packs. Together with the ADR check files, they form
the current local decision-enforcement set.

## Promoting to first-party

If a check here proves valuable to other opensip-cli consumers,
promote it to `packages/fitness/checks-typescript/src/checks/`
(as a `.ts` file with the full first-party machinery: barrel
export, display entry, dedicated unit tests). The project-local
version can stay as the worked example, with a header comment
noting "see also packages/fitness/checks-typescript/... for the
first-party version of this check."
