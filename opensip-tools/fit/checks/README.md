# Project-local fitness checks for opensip-tools

This directory holds **project-local** fit checks that the
opensip-tools repo uses to analyze itself. They are auto-discovered
by the plugin loader (see `packages/core/src/plugins/discover.ts`)
and run as part of every `pnpm fit` invocation against this repo.

## Dual purpose

These checks serve two audiences:

1. **Enforcement for this codebase.** Each check encodes a convention
   we care about — committed `it.only`, raw `console.log` in
   production, etc.
2. **Documentation-by-example for plugin authors.** opensip-tools
   is open-source. Anyone evaluating it or learning to author their
   own checks can read these files top-to-bottom to see how
   `defineCheck` is actually used in practice. We deliberately
   author these checks to be **readable** — small files, lots of
   explanatory comments, no clever abstractions.

## Conventions for new project-local checks

- **File shape:** ES modules with `.mjs` extension. The plugin
  loader auto-discovers `.js` and `.mjs` (not `.ts`).
- **Required export:** `export const checks = [defineCheck({...})]`
  — see `packages/core/src/plugins/__tests__/discover.test.ts:68-104`
  for the contract.
- **Imports:** `import { defineCheck, isTestFile, ... } from '@opensip-tools/fitness'`.
  Resolves via workspace linkage in this monorepo and via the
  published package in any other consumer.
- **UUID:** every check needs a fresh `id` field — generate with
  `uuidgen`.
- **Comments:** prioritize "why this shape" over "what this code
  does." A reader landing here is learning the pattern, not
  reviewing the implementation.
- **Tests:** project-local checks don't get a per-file Vitest
  config. Coverage comes from the integration test at
  `packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts`.
- **Slug naming:** project-local checks that demonstrate patterns also
  shipped as first-party (e.g. `no-focused-tests`, `no-console-log`
  exist in `@opensip-tools/checks-universal`) must use a distinct
  slug — prefix with `dogfood-` so they don't shadow the shipped
  versions in the registry.

## Promoting to first-party

If a check here proves valuable to other opensip-tools consumers,
promote it to `packages/fitness/checks-typescript/src/checks/`
(as a `.ts` file with the full first-party machinery: barrel
export, display entry, dedicated unit tests). The project-local
version can stay as the worked example, with a header comment
noting "see also packages/fitness/checks-typescript/... for the
first-party version of this check."
