# Unwired Features Audit and Remediation Plan

> **Resolution status (2026-06-09).** **P1-1 is FIXED**: `fit`/`graph`/`sim` now
> read their resolved namespace off `scope.toolConfig` via `currentScope()`
> (ADR-0023, Phase 4), and the declared env bindings
> (`OPENSIP_FIT_FAIL_ON_ERRORS` / `OPENSIP_FIT_FAIL_ON_WARNINGS`) drive the gate
> exit code — proven by `fit-env-precedence-e2e.test.ts`; guardrails
> `no-config-loader-outside-config` + `one-config-document` enforce it.
> **P2-1, P2-2, P3-2 are FIXED**: public `--json`/config-reference/CLI-dispatch
> docs were corrected to the shipped `CommandOutcome` + strict-validation +
> dynamic-`commandSpecs` surface. **P3-1 (completion flag drift) remains open**
> as a deliberately deferred low-priority item. The findings below are retained
> as the historical record.

## 1. Purpose

This audit looks for "unwired features": places where opensip-tools claims, documents, registers, or exposes a production capability, but the actual runtime path is missing, bypassed, placeholder-backed, silently no-op-backed, or only proved by docs/tests instead of a production entrypoint.

This is not a normal unused-code audit. `pnpm knip` was run, but the main question was reachability and wiring from public surface to concrete runtime dependencies.

Scope covered:

- Repository guidance: `CLAUDE.md` was present; no `AGENTS.md` was found.
- Decisions: `docs/decisions/`.
- Reference docs: `docs/public/70-reference/` because `docs/reference/` does not exist in this tree.
- Relevant plans/specs under `docs/plans/`.
- CLI composition roots, tool registration, command specs, config composition, capability loading, signal delivery, persistence/session replay, and completion generation.
- Route/DBOS workflow registration scans; this repository appears to be a CLI-first codebase, with no app route registration or DBOS workflow registration surface.

## 2. Audit Method

For each claimed capability, I traced:

1. Public claim: docs, ADRs, comments, command names, config declarations, env declarations, command specs, and completion docs.
2. Production entrypoint: Commander registration through `bootstrapCli`, `mountAllToolCommands`, `registerCliCommands`, or host subcommand specs.
3. Handler path: command spec handler, raw-stream branch, renderer/JSON dispatch, persistence, delivery, or config loader.
4. Composition-root binding: registries, scope contribution, capability registry replacement, datastore thunk, signal sink, and `scope.toolConfig`.
5. Concrete effect: stdout, exit code, SARIF/report upload, SQLite persistence, cloud signal sink, or session replay.
6. Tests and guardrails: only where they prove the production path or where they are themselves advertised as enforcement.

I avoided flagging test-only stubs, intentionally internal worker commands, and dead code that does not support a false product/architecture claim.

## 3. Priority Summary

| Priority | Count | Findings |
|---|---:|---|
| P0 | 0 | No user-visible safety, destructive, billing, lifecycle, or security unwiring found. |
| P1 | 1 | The composed config/precedence plane is attached to scope but not consumed by tool hot paths. |
| P2 | 2 | Public JSON docs still describe retired bare-envelope/error shapes; configuration reference describes pre-ADR behavior that strict production validation rejects. |
| P3 | 2 | Shell completion omits public first-party flags; implementation docs still describe removed static imports/`register()` wiring. |

## 4. Findings Grouped By Priority

### P1-1: Resolved tool config is composed but not consumed by production tool paths

**Impact**

The code claims a resolved config plane with `flag > env > file > defaults` precedence and tool consumption through `scope.toolConfig`, but the fit/graph/sim hot paths still read legacy config loaders. File config mostly still works through those loaders, but the newer declaration-owned precedence layer is not the runtime source of truth. In particular, declared env bindings such as `OPENSIP_FIT_FAIL_ON_ERRORS` and `OPENSIP_FIT_FAIL_ON_WARNINGS` are resolved into `scope.toolConfig` but appear to be no-ops for actual `fit` execution.

**Evidence**

- Claimed precedence: `packages/config/src/precedence.ts:4-12` documents `flag > env > file > defaults`, and `packages/config/src/precedence.ts:120-124` merges env and flags.
- Claimed scope handoff: `packages/cli/src/bootstrap/config-and-capabilities.ts:8-15` says the host composes, validates, resolves precedence, and returns config for the scope; `packages/cli/src/bootstrap/config-and-capabilities.ts:23-25` says tools read their namespace off `scope.toolConfig`.
- Claimed tool access: `packages/core/src/lib/scope-types.ts:42-51` and `packages/core/src/lib/scope-types.ts:93-99` say tools read `scope.toolConfig?.graph`, `?.fitness`, or `?.simulation`.
- Production attachment exists: `packages/cli/src/bootstrap/pre-action-hook.ts:269-312` computes `toolConfig` and assigns it onto the `RunScope`.
- Claimed env bindings exist: `packages/fitness/engine/src/config/fitness-config-schema.ts:65-67` declares `OPENSIP_FIT_FAIL_ON_ERRORS` and `OPENSIP_FIT_FAIL_ON_WARNINGS`.
- Actual fit hot path bypasses `scope.toolConfig`: `packages/fitness/engine/src/cli/fit/config-loader.ts:32-42` loads `loadSignalersConfig`/`loadTargetsConfig`; `packages/fitness/engine/src/cli/fit.ts:122-149` reads `signalersConfig.fitness.*` for recipe/default/disabled checks.
- Actual graph hot path bypasses `scope.toolConfig`: `packages/graph/engine/src/cli/graph/graph-command-spec.ts:139-143` calls `loadGraphConfig(opts.cwd)`; `packages/graph/engine/src/cli/graph-config.ts:48-63` re-resolves and reads YAML.
- Actual sim hot path bypasses `scope.toolConfig`: `packages/simulation/engine/src/cli/sim-config.ts:25-44` reads `simulation.recipe` from YAML directly.
- The older fitness schema even notes the deferred migration: `packages/fitness/engine/src/signalers/schema.ts:29-34` says the loader remains until fitness reads targeting off composed scope config.

**Claimed Behavior Source**

ADR-0023's "one composed config document" decision (`docs/decisions/ADR-0023-config-package-and-schema-registry.md:26-33`), the config precedence package, the `RunScope.toolConfig` contract, and the `fitnessConfigDeclaration.env` bindings.

**Actual Production Wiring State**

The composition root validates and resolves the document, then stores the result on scope. The production command handlers do not read that value; they continue to read YAML through legacy loaders. This makes `scope.toolConfig` mostly validation metadata rather than the runtime configuration source.

**Recommended Remediation Options**

- **Implement:** Move fit/graph/sim runtime reads to `cli.scope.toolConfig.<namespace>` and consume legacy loaders only for still-unmigrated targeting/scoping blocks.
- **Implement:** Pass command-line flag overrides into `resolveConfig` or remove the claim that the composed tool config includes flags.
- **Hide/disable:** Remove env bindings from `ToolConfigDeclaration` until the tools consume resolved config.
- **Document as deferred:** If this is intentionally mid-migration, mark the env/precedence plane as validation-only and remove user-facing implication that it affects runtime.

**Acceptance Criteria**

- A `fit` run with `OPENSIP_FIT_FAIL_ON_ERRORS=0` changes the `shouldFail`/exit-code behavior without editing `opensip-tools.config.yml`.
- A graph run uses `scope.toolConfig.graph` for rule knobs and recipe defaults.
- A sim run uses `scope.toolConfig.simulation.recipe` for recipe defaults.
- A search for `toolConfig` shows real consumers in first-party tools, not only core/CLI composition code.
- Any remaining direct YAML config projection is documented as a bounded exception with a guardrail.

**Suggested Tests or Guardrails**

- E2E test: set `OPENSIP_FIT_FAIL_ON_ERRORS=0`, run a fixture that emits an error-rung signal, assert exit code changes.
- E2E test: set `OPENSIP_FIT_FAIL_ON_WARNINGS=1`, use warning-only fixture, assert exit code changes.
- Unit/integration test: graph config field in `scope.toolConfig.graph` reaches a rule without a second file read.
- Guardrail: first-party tool engines may not read their own namespace from `opensip-tools.config.yml` except through the composed scope config.

### P2-1: Public JSON docs still advertise retired bare-envelope and bare-error shapes

**Impact**

CI users following several public docs will parse the wrong JSON shape. Current production `--json` output wraps run envelopes under `.envelope` and errors under `.errors[]`, but some docs still tell users to read top-level `.verdict`, `.units`, or a bare `{ "error": "..." }`.

**Evidence**

- Stale fit output map: `docs/public/20-fit/04-output-gate-sarif.md:42` says `--json -> SignalEnvelope JSON on stdout`.
- Stale fit JSON path: `docs/public/20-fit/04-output-gate-sarif.md:125` says the returned envelope goes through `formatSignalJson`; `docs/public/20-fit/04-output-gate-sarif.md:131-137` shows `jq '.verdict.*'`.
- Stale sim doc: `docs/public/30-sim/02-execution-model.md:123` says `--json` output is the envelope itself.
- Stale graph doc: `docs/public/40-graph/01-stages-and-catalog.md:209` says the envelope is the JSON.
- Mixed reference doc: `docs/public/70-reference/04-json-output-schema.md:18-20` correctly documents `CommandOutcome`, but `docs/public/70-reference/04-json-output-schema.md:100` and `docs/public/70-reference/04-json-output-schema.md:244-248` still use top-level `.verdict`/`.units`.
- Stale error shape: `docs/public/70-reference/04-json-output-schema.md:196-206` still shows a bare `{ "error": "..." }`.
- Production wrapper path: `packages/cli/src/cli-context.ts:346-364` wraps `emitJson`/`emitEnvelope` in `CommandOutcome`; `packages/cli/src/commands/render-outcome.ts:14-16` states `.envelope`/`.data`; `packages/cli/src/error-handler.ts:174-180` renders structured error outcomes for `--json`.

**Claimed Behavior Source**

Public fit/sim/graph docs and the JSON output schema reference.

**Actual Production Wiring State**

The production path is wired to `CommandOutcome`. The docs are inconsistent: migration/reference intro is correct, while workflow pages and examples still teach the old surface.

**Recommended Remediation Options**

- **Implement:** Update all JSON examples to `.envelope.verdict.*`, `.envelope.units`, `.data`, and `.errors[]`.
- **Hide/disable:** Remove stale examples from per-tool pages and link only to the canonical JSON schema reference.
- **Document as deferred:** Not recommended; this is a shipped breaking change and the docs should be consistent.

**Acceptance Criteria**

- `rg "jq '\\.verdict|envelope \\*is\\* the JSON|\\\"error\\\"" docs/public` returns only migration-history references, not current instructions.
- All per-tool docs link to the `CommandOutcome` section before showing jq examples.
- Error examples show `status: "error"` plus `errors[]`.

**Suggested Tests or Guardrails**

- Docs smoke test that runs one fixture `fit --json`, `sim --json`, and `graph --json` sample and verifies every documented `jq` expression.
- Markdown lint/grep guardrail blocking new current-doc examples that read top-level `.verdict` from `--json`.

### P2-2: Configuration reference describes config keys and validation behavior that production rejects

**Impact**

The configuration reference is marked current, but it describes pre-composed-schema behavior. Users following it can add `fitness.schedules` or `simulation.schedules` expecting a local no-op, but strict production validation rejects unknown keys in known namespaces. The same page says malformed `graph:` values are dropped, while production strict validation rejects them before dispatch.

**Evidence**

- Stale source claims: `docs/public/70-reference/03-configuration.md:8-15` lists old source files; `docs/public/70-reference/03-configuration.md:31` says the strict schema lives in `packages/fitness/engine/src/signalers/schema.ts`.
- Stale schema coverage: `docs/public/70-reference/03-configuration.md:50` says `plugins:` and `graph:` are read out-of-band.
- Claimed ignored schedule keys: `docs/public/70-reference/03-configuration.md:115` says `fitness.schedules` is ignored locally and unknown keys are silently dropped; `docs/public/70-reference/03-configuration.md:139` says `simulation.schedules` is ignored.
- Claimed graph tolerance: `docs/public/70-reference/03-configuration.md:213` says malformed graph values are dropped and the rule uses defaults.
- Production strict namespace behavior: `packages/config/src/composer.ts:40-43` makes object namespaces strict; `packages/config/src/composer.ts:70-77` composes strict namespaces; `packages/cli/src/bootstrap/config-and-capabilities.ts:132-135` validates before dispatch.
- Production fitness schema has no `schedules`: `packages/fitness/engine/src/config/fitness-config-schema.ts:34-49`.
- Production simulation schema has no `schedules`: `packages/simulation/engine/src/cli/sim-config-schema.ts:24-27`.
- Production graph schema is declared and strict-composed: `packages/graph/engine/src/cli/graph-config-schema.ts:43-61` and `packages/graph/engine/src/cli/graph-config-schema.ts:85-88`; `packages/graph/engine/src/tool.ts:240-244` contributes it to the host.

**Claimed Behavior Source**

The public configuration reference and ADR-0023's composed-schema architecture.

**Actual Production Wiring State**

The production validator is stricter than the reference. Reserved schedule keys are not part of the schema, so they fail when present under known namespaces. Graph config is not merely permissive at command runtime because the composed validator runs first.

**Recommended Remediation Options**

- **Hide/disable:** Remove `schedules` from current configuration docs until cloud scheduling exists.
- **Document as deferred:** Move schedule fields to a clearly non-schema roadmap section and say they are rejected by current CLI config validation.
- **Implement:** Add `schedules` as optional explicitly ignored fields if no-op acceptance is intentional.
- **Implement:** Generate the config reference from registered declarations plus host declarations, or at least add a doc-source path existence check.

**Acceptance Criteria**

- Every YAML field shown in the configuration reference is accepted by the current strict schema, or the doc explicitly says it is not currently accepted.
- The graph section says malformed/unknown graph fields fail config validation before command dispatch.
- The `source-files` block points to existing, authoritative files.

**Suggested Tests or Guardrails**

- A docs config-fixture test that validates every YAML snippet in `03-configuration.md`.
- A path checker for frontmatter `source-files`.
- A generated schema/reference snapshot from `hostConfigDeclarations()` plus registered tool declarations.

### P3-1: Shell completion omits wired public first-party flags

**Impact**

The commands are registered and work, but generated bash/zsh/fish completion does not surface several public flags. This is not a runtime failure, but completion is a public CLI feature and currently trails the command specs.

**Evidence**

- Completion claims static scripts complete canonical subcommand/flag names: `packages/cli/src/commands/completion.ts:13-19`.
- Fit completion list omits wired `--show`, `--gate-save`, and `--gate-compare`: `packages/cli/src/commands/completion.ts:95-107`; fit declares those flags at `packages/fitness/engine/src/cli/fit/fit-command-spec.ts:127-142`.
- Sim completion list omits wired `--show`: `packages/cli/src/commands/completion.ts:109-114`; sim declares it at `packages/simulation/engine/src/tool.ts:283-289`.
- Graph has no graph-specific completion arm, so bash/zsh fall back to common flags: `packages/cli/src/commands/completion.ts:149-157`; graph declares public flags at `packages/graph/engine/src/cli/graph/graph-command-spec.ts:388-436`.
- Fish completion emits per-subcommand lines only for fit, sim, and uninstall: `packages/cli/src/commands/completion.ts:216-224`.
- The drift test covers subcommands, not per-command flags: `packages/cli/src/__tests__/completion-subcommands.test.ts:88-110`.

**Claimed Behavior Source**

The `completion` command, completion generator comments, and CLI reference statement that the static list is drift-tested (`docs/public/70-reference/01-cli-commands.md:628`).

**Actual Production Wiring State**

Public command flags are wired through `CommandSpec` and mounted by Commander, but the completion script has hand-maintained subsets and no graph-specific flag list.

**Recommended Remediation Options**

- **Implement:** Generate completion flag inventories from live `CommandSpec`s and `commonFlags`.
- **Implement:** Add a per-command flag drift test comparing completion output to Commander/spec flags for public commands.
- **Document as deferred:** If static completion intentionally covers only common flags, document the narrower guarantee.

**Acceptance Criteria**

- Generated completion includes all public flags for `fit`, `sim`, and `graph`, excluding internal worker/export commands by explicit allowlist.
- A new command-spec option fails a completion drift test until completion is updated or explicitly excluded.

**Suggested Tests or Guardrails**

- Snapshot the public command-to-flag inventory and assert bash/zsh/fish output contains each public flag.
- Keep an explicit internal-only exclusion list for `fit-run-worker`, `sim-run-worker`, `graph-run-worker`, `graph-shard-worker`, `catalog-export`, and `sarif-export`.

### P3-2: Implementation dispatch doc still describes removed static import and `Tool.register()` wiring

**Impact**

This is mostly documentation/architecture drift, but it matters for plugin authors and maintainers auditing wiring. The current runtime uses dynamic package resolution, manifests, and `commandSpecs`; the implementation doc still contains an example with static first-party tool registration and `fitnessTool.register(ctx)`.

**Evidence**

- Stale doc claim: `docs/public/80-implementation/01-cli-dispatch.md:97` says the dispatch path uses static imports and explicit registration calls.
- Stale example: `docs/public/80-implementation/01-cli-dispatch.md:201-203` says bootstrap registers `fitnessTool`, `simulationTool`, `graphTool`, then calls `fitnessTool.register(ctx)`/siblings.
- Actual dynamic bundled tool loading: `packages/cli/src/bootstrap/register-tools.ts:50-61` says bundled tools are package names, not static imports, loaded through the same manifest/import path as installed tools.
- Actual command mounting: `packages/cli/src/bootstrap/register-tools.ts:520-523` says `commandSpecs` are the one command surface; `packages/cli/src/bootstrap/register-tools.ts:568-573` mounts each spec via `mountCommandSpec`.
- Actual tool descriptor confirms removed fallback: `packages/fitness/engine/src/tool.ts:230-233` says the deprecated `register()` fallback is gone.

**Claimed Behavior Source**

Public implementation reference.

**Actual Production Wiring State**

Production is correctly on dynamic manifest admission and declarative command specs. The doc is stale and may cause false audits or incorrect plugin guidance.

**Recommended Remediation Options**

- **Implement:** Update the implementation doc example to the manifest -> `admitTool` -> dynamic import -> `commandSpecs` flow.
- **Delete:** Remove line-by-line lifecycle examples that are duplicated in source comments and ADRs.
- **Document as deferred:** Not recommended; this is already shipped behavior.

**Acceptance Criteria**

- The implementation doc no longer mentions static first-party tool imports or `Tool.register()`.
- The example path names `BUNDLED_TOOL_PACKAGES`, manifest admission, dynamic import, and `mountCommandSpec`.

**Suggested Tests or Guardrails**

- A docs grep check for retired terms in current docs: `fitnessTool.register`, `simulationTool.register`, `graphTool.register`, and "static imports" in CLI dispatch context.
- Path-existence checks for implementation docs' source links.

## 5. Cross-Cutting Guardrails To Prevent Recurrence

- Add an "unwired feature" CI check that maps public `CommandSpec`s to completion entries, JSON docs, and at least one test or handler path.
- Add config-runtime proof tests for every `ToolConfigDeclaration.env` binding and every documented config key that claims runtime effect.
- Generate config and env references from declarations where possible; otherwise validate all docs YAML snippets against the composed schema.
- Add doc grep guards for retired architecture terms after major cutovers (`register()`, bare `SignalEnvelope` JSON, bare `{ error }`, static bundled tool imports).
- Keep a small exception registry for intentional no-op/deferred behavior. Each entry should name the config key/command, the user-visible response, and the test that proves it fails clearly or is safely ignored.
- For CLI completion, derive public flag lists from mounted command specs or snapshot them from the live Commander program.

## 6. Done Definition

This audit is done when:

- P1/P2 findings are either implemented, hidden/disabled, deleted, or explicitly documented as deferred with unavailable behavior.
- Public docs have no current instructions that contradict production JSON/config behavior.
- `scope.toolConfig` is either the real runtime source for tool-owned config, or the comments/env bindings/precedence claims are reduced to the behavior actually shipped.
- Completion has a flag-level drift guard or documents its reduced coverage.
- `pnpm knip` findings are either cleaned up or tracked separately as mechanical cleanup, not mixed into runtime-wiring claims.

## 7. Commands Run And Limitations

Commands run:

- `pnpm knip`
  - Exit code: 1.
  - Result: reported many unused files, largely fixtures/generated or mechanical cleanup candidates, plus config hints for check packages. I did not treat these as unwired runtime findings without a product/architecture claim.
- Required targeted scan:
  - `rg -n "Noop|No-op|Placeholder|NotBound|NOT_WIRED|unwired|stub|TODO|throw new Error|not implemented|feature flag|registerRoute|registerWorkflow|DBOS" ...`
  - Result: no production route or DBOS workflow registration surface found; most hits were docs/tests/check implementations/comments.
- Production caller/config scans:
  - `rg -n "toolConfig" packages ...`
  - `rg -n "registerRoute|registerWorkflow|DBOS" ...`
  - `rg -n "formatSignalJson|jq '\\.verdict|SignalEnvelope JSON on stdout|\\\"error\\\"" docs/public docs/decisions packages ...`
  - `rg -n "loadSignalersConfig|loadGraphConfig|readSimulationRecipe|readYamlFile" packages ...`
- Composition-root reads:
  - `packages/cli/src/index.ts`
  - `packages/cli/src/bootstrap/register-tools.ts`
  - `packages/cli/src/bootstrap/pre-action-hook.ts`
  - `packages/cli/src/bootstrap/config-and-capabilities.ts`
  - `packages/cli/src/commands/mount-command-spec.ts`
  - tool roots in fitness/simulation/graph.

Limitations:

- This was a static/source-level audit plus targeted command scans. I did not run the full test suite or execute every CLI command.
- `docs/reference/` does not exist in this repo; I audited `docs/public/70-reference/` as the reference source.
- I did not inspect `docs/web-generated/` except where search results showed it mirrored public docs; findings cite public source docs.
- No app-server route registration or DBOS workflow registration appears present in this repository; those categories were treated as not applicable rather than as missing features.
