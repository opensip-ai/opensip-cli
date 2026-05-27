# Implementation note — partial supersession (2026-05-27)

This plan was authored to **port two checks** (`no-focused-tests`, `no-console-log`) **and wire the dogfood loop**. During Phase 0 execution in worktree `worktree-agent-acb84d58c7331d0cb`, research revealed that BOTH checks already ship first-party in `@opensip-tools/checks-universal`:

- `packages/fitness/checks-universal/src/checks/testing/no-focused-tests.ts`
- `packages/fitness/checks-universal/src/checks/quality/code-structure/no-console-log.ts`

Phases 2, 3, and 4 (the check ports + integration test for them) were therefore **discarded**. Only the dogfood-loop infrastructure was carried forward into branch `ci/dogfood-fit-loop` and ultimately merged.

## What landed vs. what was dropped

| Phase | Status | What landed |
|---|---|---|
| 0 | ✅ Partial | `opensip-tools/fit/checks/README.md`, audit findings, design decisions. The README scaffolding is reusable for genuine future project-local checks. |
| 1 | ✅ Full | CI workflow runs `pnpm fit:ci` + SARIF export + upload to GH Code Scanning on every PR. CLAUDE.md "Dogfood Gate" section added. |
| 2 | ❌ Discarded | `no-focused-tests` already shipped in `checks-universal`. |
| 3 | ❌ Discarded | `no-console-log` already shipped in `checks-universal`. |
| 4 | ❌ Discarded | Integration test depended on Phases 2 and 3. |
| 5 | ✅ Local parts | `pnpm fit:ci` runs cleanly on main; build/typecheck/test/lint pass. Tasks 5.2/5.3 (synthetic-violation PR validation) require a real PR — to be exercised naturally as new PRs land. |

## Side discoveries during Phase 0 execution

These are real findings worth tracking even though they weren't in the plan's named scope:

1. **`pnpm fit` loaded 0 checks on a clean main.** pnpm workspace deps were not materializing at the root `node_modules/`, so the CLI's check-loading mechanism saw nothing. Fixed by adding `pnpm.injectWorkspacePackages: true` to `package.json` plus root devDeps for `@opensip-tools/checks-*`. Pre-existing bug; the dogfood loop couldn't have functioned without this fix.
2. **`test-file-pairing` disabled in `opensip-tools.config.yml`.** Removed 194 of 381 error-level findings. Rationale: this repo's integration-test-first convention doesn't follow 1:1 source-to-test pairing.
3. **187 remaining error-level findings** form the implicit baseline. Per ratchet **(B) GitHub Code Scanning** (chosen in Phase 0 Task 0.2), GH compares new PR uploads against the latest main-branch SARIF and surfaces only net-new alerts.

## What the original plan's research missed

The plan's authoring grepped `@opensip-tools/checks-typescript` and found 3 of 5 candidates already ported. It did NOT grep `@opensip-tools/checks-universal`, where the remaining 2 were also already ported. Future plans involving "port from sibling repo" work should grep ALL `checks-*` packages — categorization in the source repo doesn't predict where checks end up locally.

## Follow-up

The original plan's "Follow-up plans" section called for brainstorming additional opensip-tools-specific project-local checks. **That follow-up is now where the genuinely-novel teaching artifacts will land.** The `opensip-tools/fit/checks/README.md` scaffolding from this plan + the working CI dogfood loop give that follow-up a clean place to drop the first real project-local check whenever it's identified.
