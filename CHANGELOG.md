# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Tool config is consumed from the composed `scope.toolConfig`** (ADR-0023,
  Phase 4). `fit`, `graph`, and `sim` now read their resolved namespace off the
  host-composed, strict-validated config document via `currentScope()`
  (scope-first; the legacy per-tool YAML loader is kept only as a no-scope
  fallback for config-less projects and direct unit tests). This makes the
  declared environment bindings actually drive runtime behaviour:
  `OPENSIP_FIT_FAIL_ON_ERRORS` / `OPENSIP_FIT_FAIL_ON_WARNINGS` now change the
  gate exit code with no config-file edit (previously resolved into scope but
  ignored by the hot path). Two guardrails keep it honest: the new
  `no-config-loader-outside-config` check, and `one-config-document` no longer
  exempts the migrated document-level loaders.

### Removed

- **`fit --findings` removed.** The deprecated alias of `--verbose` (ADR-0021),
  kept through the 2.x line, is gone as of 3.0.0 — use `--verbose` / `-v`.

### Fixed

- **Public docs aligned with the 3.0.0 surface.** `--json` examples now show the
  `CommandOutcome` wrapper (`.envelope` / `.data` / `.errors[]`) instead of the
  retired bare-envelope / top-level `.verdict` / bare `{ "error" }` shapes; the
  configuration reference reflects strict whole-document validation (unknown keys
  in known namespaces are rejected, not silently ignored, and malformed `graph:`
  values fail before dispatch); sim packs are documented as discovered by
  `<scope>/scenarios-*` name-pattern (ADR-0029), not a `sim-pack` marker; the
  CLI-dispatch implementation doc describes the dynamic manifest/`commandSpecs`
  flow (no `Tool.register()`); and version / six-layer / 32-package /
  check-count claims match v3.0.0.
- **`env-via-registry` and `no-local-exit-or-stdout` removed from
  `@opensip-tools/checks-universal`** (relocated to opensip-tools' own
  project-local dogfood pack). Both were tool-internal SELF-checks that leaked
  into the universal pack: `env-via-registry` (§5.12) mandates reads through
  opensip-tools' own `EnvRegistry` primitive and allow-lists opensip-tools-internal
  files (`host-env-specs.ts`, `theme.ts`); `no-local-exit-or-stdout` (§4.7) encodes
  opensip-tools' termination convergence (typed `BootstrapError`/`ToolError`,
  single-boundary `process.exitCode`). Neither is a framework-agnostic invariant — a
  consumer codebase has no `EnvRegistry` and may use a different, equally valid
  termination architecture (e.g. a sanctioned process-exit wrapper package), so the
  checks false-fired across consumer code. They now live in
  `opensip-tools/fit/checks/*.mjs` (the repo still self-enforces them); the universal
  pack holds only framework-agnostic checks. Consumers previously recipe-excluding
  these no longer need to.

## [3.0.0] — 2026-06-08

**GA — the tool-plugin parity cutover.** The platform's single acceptance test
(north-star §1) now answers **yes**: a first-party tool loads through the plugin
path with behaviour identical to the bundled build. The privileged first-party
paths the 2.x ladder built *alongside* the parity planes are removed, so the only
thing distinguishing a bundled tool from an installed or project-local one is its
**source of installation, never its lifecycle** (ADR-0027, realizing ADR-0012's
3.0.0 reservation). All nine §8 completion invariants are live guardrails
(`docs/internal/parity-invariant-index.md`).

> **CLI users: nothing changes.** Every command, flag, `--json` shape (the 2.12.0
> `CommandOutcome`), config file, and exit code is byte-identical to 2.13.0. The
> breaking changes below are **author-facing only** — see
> [Migrating to 3.0](docs/public/70-reference/11-migrating-to-3.0.md).

### Removed (BREAKING — plugin authors)

- **`Tool.register()` and the raw-Commander `program` handle** are gone from the
  tool contract. A tool declares typed `commandSpecs` and the host mounts them —
  the one command surface. A tool that mounted via `register()` must migrate to
  `commandSpecs`; a handler can no longer reach raw Commander (it is gone from the
  type).
- **The `apiVersion` grace window.** A tool declaring no `apiVersion` is no longer
  admitted off the `kind:'tool'` marker alone — it fail-closes (explicitly run) or
  is skipped with a diagnostic (discovered). Declare `apiVersion` in the manifest.

### Changed

- **One unified tool loader.** Bundled tools load by package name through the same
  `loadToolManifest → admitTool → dynamic import → register` path an installed or
  project-local tool travels — the host holds no static `import { fitnessTool }`.
  Install-source independence is now structural, not merely tested.

### Added

- **The acceptance test as CI** — `fit` (the strongest tool) loaded through the
  plugin path is asserted identical to the bundled mount: a component test pins the
  command surface, and an end-to-end test runs the real binary TWICE on the same
  project — once bundled, once with `fit` dropped from the bundled set so it loads
  through the external/installed path — and asserts the check list, `--help`,
  `fit --json` `CommandOutcome`, and exit code are identical.
- **`OPENSIP_TOOLS_SKIP_BUNDLED`** — drop a bundled tool (`fitness`/`simulation`/
  `graph`) from the bundled set so an installed or project-local package of the
  same id takes over: the install-source-independence escape hatch made real.
- **`no-bootstrap-tool-import`** guardrail (the host must not statically import a
  tool runtime) + the **completion-invariant index** with a CI assertion that every
  §8 invariant maps to a live check.

### Changed — generic capability discovery ([ADR-0029](docs/decisions/ADR-0029-generic-capability-discovery.md))

- **One generic discovery substrate.** Every capability domain — fit's `fit-pack`,
  sim's `sim-pack`, graph's `graph-adapter`, plus co-located `fit-recipe`/`sim-recipe`
  — is now discovered and loaded by a single descriptor-driven substrate in
  `@opensip-tools/core` (`discoverCapabilityContributions` → the scope-owned
  `loadCapabilityDomain` → `CapabilityRegistry.routeContribution` → the owner's
  registrar). The three bespoke per-tool loaders are **deleted**, including graph's
  host-coupled, eager `register-graph-adapters.ts` (which static-imported graph's
  internals and stashed adapters in a module global — the §4.5 leak). A tool's
  manifest `discovery` descriptor is the single source of truth for how its packs are
  found (`marker`/`name-pattern`, the `@opensip-tools` built-in split, explicit-list
  `replace`/`augment`, recipe co-contributions); the kernel branches on no domain
  identity. `routeContribution` — wired-but-dead since 2.10.0 — is now the one live
  conduit. CLI behaviour is unchanged.
- **`MARKER_KINDS` retired to the host `'tool'` marker.** Domain markers are
  manifest-declared, not a compiled-in host union; the workspace-invariant test
  derives valid markers from manifests.

### Fixed — scope isolation (modular-monolith audit F1/F2/F3)

- **F1** — sim's module-level `scenariosLoadedFor`/`pluginLoadErrors` singletons →
  `scope.simulation.load` (mirrors `scope.fitness.load`). Two concurrent sim runs
  carry independent load state.
- **F2** — the language parse cache is scope-owned (`currentScope().parseCache`),
  not a module-global `activeCache`. Concurrent runs no longer share parse state.
- **F3** — fitness's `mergedCheckDisplay` singleton is gone: check display
  (`icon`/`displayName`) travels ON each check (`check.config`), folded from a pack's
  authoring map at the pack boundary; `getDisplayName`/`getIcon` read the scope's
  check registry.
- **`no-module-singleton` tightened** to catch the F1/F2 module-`let` shapes
  (loaded-state markers, mutable-accumulator-typed bindings) so the class can't
  regress (141 checks).

### Performance

- **Live (TTY) runs execute the engine off the main process** ([ADR-0028](docs/decisions/ADR-0028-off-main-thread-execution.md)).
  An interactive `fit`/`sim`/`graph` run forks a headless worker subcommand
  (`fit`/`sim`/`graph-run-worker`) over the `ProgressTransport` seam, so the render
  thread runs only Ink + the 80 ms clock — the spinner and elapsed clock no longer
  stutter or freeze-then-jump under a synchronous CPU blast (the graph TypeScript
  type-check, fit/sim check/scenario batches). Persistence + cloud egress stay on
  the parent post-run; the engine entries are persistence-free. `--json`/non-TTY
  output, exit codes, and persisted sessions are byte/row-identical (the
  rearchitecture is invisible to consumers). `OPENSIP_TOOLS_NO_WORKER=1` forces the
  in-process fallback (also taken automatically on a fork failure). A
  **`live-runs-off-thread`** guardrail (140 → 141 checks) keeps a live runner from
  regressing to in-process execution and keeps worker entries persistence-free.

The project leaves the long-lived pre-GA 2.x major for the **3.x GA line**. Future
tools (`audit`/`lint`/`bench`) slot in by shipping a manifest + `commandSpecs`,
inheriting every host-owned plane, with zero CLI change.

## [2.13.0] — 2026-06-08

**Execution · Severity · the sim proof slice.** "Same words mean same semantics"
becomes true across tools, graph-rule authors are shielded to the check-authoring
bar, and the tool-plugin spine is proven with a real externalization
(north-star §5.8/§5.9/§8/§4.8). Additive — no `--json`/CLI break.

### Fixed

- **`graph` no longer flags functions in `__fixtures__/` as findings.** The
  TypeScript adapter now treats `__fixtures__/` directories as test scaffolding
  (alongside `__tests__/` and `*.test.*`), so a synthetic fixture (e.g. the
  orchestrator's `__fixtures__/multi-pkg/` mini-repo) no longer over-triggers
  `graph:orphan-subtree` on a full single-process build.
- **`sim`'s `execution.timeout` now aborts a runaway scenario.** It was declared
  but silently dead (`runSingle` ran against a signal nothing ever aborted).
  Simulation now runs on the shared execution substrate, so `timeout` /
  `maxParallel` / `stopOnFirstFailure` mean the same thing they do in fitness
  (parallel mode now honours `stopOnFirstFailure` too).

### Added

- **Execution substrate (`@opensip-tools/core`).** One bounded scheduler +
  per-unit timeout/retry (`scheduleUnits`, `runWithTimeout`, `runWithRetry`,
  `executePipeline`) + a unified `WorkflowExecutionOptions` + `deriveRecipeId`,
  hoisted from fitness's proven scheduler. Fitness runs on it byte-identically; sim
  adopts it (the timeout fix). Graph stays selection-only — an intentional,
  ADR-documented difference (ADR-0026).
- **Severity & Signal policy.** A central `SeverityPolicy` (author→wire mapping +
  the override clamp + the gate's error/warning predicate, one source of truth) and
  identity-stamping factories `createSignalFromViolation` (core) and
  `createGraphSignal` (graph). Every graph rule now stamps `source`/`ruleId`/
  `severity` via the factory instead of retyping it — closing the SARIF-fingerprint
  drift risk; signal output byte-identical.
- **Sim externalization proof slice.** A test loads the real `sim` package through
  the external plugin loader (manifest + admission gate + dynamic import +
  `mountCommandSpec`), asserting an identical command surface — de-risking the
  3.0.0 `fit` proof.
- **Three guardrails:** `same-recipe-semantics`, `graph-signal-stamped`,
  `docs-teach-blessed-seam` (136 → 139 checks); the extend-docs now teach the
  blessed `CommandSpec` seam.

## [2.12.0] — 2026-06-08

**Output & Observability planes.** Every command result and error — including the
pre-handler bootstrap failures where `--json` matters most — now has one outer
`CommandOutcome` shape (north-star §5.5/§5.10/§4.7/§5.12, ADR-0024). The host
**assembles** the outcome from each tool's unchanged domain return; no tool
chooses its own error JSON or success carrier.

### Breaking

- **`--json` now emits a `CommandOutcome` wrapper.** The byte-identical
  `SignalEnvelope` rides under `.envelope` (run commands `fit`/`graph`/`sim`); a
  `CommandResult` rides under `.data` (list/dashboard/`init`/`sessions`/`plugin`);
  a failure carries structured `.errors[]`. Read `.envelope.verdict.passed` where
  you previously read `.verdict.passed`. The inner envelope and all human output
  are unchanged. Migration guide: `docs/public/70-reference/09-migrating-to-2.12.md`
  (ships as a 2.x minor break, like the 2.7.0 `--json` change).

### Added

- **Structured bootstrap errors.** No-project / schema-too-old / config-resolve /
  tool-init failures are now a `bootstrap.error` `CommandOutcome` — `fit --json` in
  a directory with no project returns a structured, suggestion-bearing error and
  exit 2 (previously: nothing structured). Human output byte-identical.
- **`RunDiagnostics` bus.** Every outcome carries a JSON-emittable `diagnostics`
  stream of lifecycle events (plugins loaded, project resolved, command executed),
  bridged to the existing OpenTelemetry trace context. Scope-owned; additive.
- **Governed environment surface.** Every env read flows through one `EnvRegistry`;
  the env surface is documented in `docs/public/70-reference/10-environment-variables.md`.
- **`cli.emitError` seam** for tool handlers, retiring the bare `emitJson({ error })`.
- **Three guardrails:** `one-outcome-shape`, `no-local-exit-or-stdout`,
  `env-via-registry` (133 → 136 checks).
- **Session replay.** `opensip-tools sessions show <ref>` reconstructs a past
  run's output from the stored session payload — `sessions show latest --tool fit`
  (or an explicit id, optionally `--json`). Each run command also takes an inline
  `--show <session>` shorthand (`fit --show latest`, `graph --show <id>`,
  `sim --show latest`). Each tool contributes a `sessionReplay` projection that
  decodes the opaque payload back into a `SignalEnvelope` (`fidelity: 'projection'`
  — rebuilt from persisted findings, not re-executed). The shared structural
  decoder lives in `@opensip-tools/session-store` (`decodeSessionPayload`); the
  per-tool severity/category/id projection stays in each engine. A missing
  session, wrong tool, or undecodable payload returns a structured `CommandOutcome`
  error (`reason`/`code`: `not-found` / `wrong-tool` / `ambiguous-latest` /
  `decode-error`) and exit 2.

## [2.11.0] — 2026-06-07

**Command plane (the spine).** The largest first-party privilege — raw Commander
access — is collapsed. Tools no longer mutate the CLI via `register(cli)`; they
**declare** typed `CommandSpec`s that the host mounts, owning flags, parsing,
help, completion, output dispatch, error mapping, and exit codes. This is the
spine of the tool-plugin-parity architecture (north-star §5.4 Command contract +
§5.6 Lifecycle hooks): an external tool can now reach the same command surface
`fit`/`graph`/`sim` use, because that surface is host-owned, not Commander-coupled.
See [ADR-0021](docs/decisions/ADR-0021-cli-flag-currency.md) (flag currency, on
which the command plane builds).

A mechanism swap, not a UX change — the CLI surface is byte-identical to 2.10.x
with a single sanctioned exception (below). Output currency stays handler-owned
(`raw-stream`) in this release; host-owned output unification is 2.12.0
(`CommandOutcome`), and the single `dispatchOutput` seam is the point it swaps in.

> ### ⚠️ Behaviour change (pre-GA)
>
> **`graph --resolution` now lists its choices in `--help`.** Validation of
> `--resolution` (`exact` | `fast`, default `exact`) moved from inside the handler
> to the host-owned declared `choices`, so `--help` now renders
> `(choices: "exact", "fast", default: "exact")`. The runtime contract is
> unchanged: an invalid value is still rejected with exit code 2.

### Added

- **`command-surface-parity` architecture guardrail.** Fails CI if a tool reaches
  the raw Commander program (`ToolCliContext.program`, `cli.program as …`,
  `program.command(...)`/`.option(...)`/`.argument(...)`) or ships a `register()`
  body without `commandSpecs`. The mechanical enforcement (north-star Principle 6)
  that keeps the privilege retired; the only documented exceptions are the
  action-less host subcommand-group parents (`sessions`, `plugin`).
- **Declarative command API (`@opensip-tools/core`).** `defineCommand` +
  `CommandSpec` / `OptionSpec` / `ArgSpec` — the typed shape a tool exports for the
  host to mount. Re-exported from `@opensip-tools/contracts` as part of the public
  Tool↔runner surface. (`CommonFlagKey` moved to core, beside the `Tool` contract.)

### Changed

- **All first-party commands are now declarative.** `fit` (+ `fit-list`/
  `fit-recipes`/`fit-baseline-export`), `graph` (+ its 7 aux subcommands), and
  `sim` migrated from hand-rolled `register()` bodies to `CommandSpec`s; graph's 8
  `register*Command` helpers (26 raw Commander calls) are gone. Host commands
  (`init`/`configure`/`sessions`/`plugin`/`dashboard`/`completion`/`uninstall`)
  mount through the same `mountCommandSpec` plane.
- **`Tool.register(cli)` is deprecated.** It remains as an additive fallback for
  external tools through the 2.x grace window; first-party tools no longer use it.
  Removal of `register()` / `ToolCliContext.program` is the 3.0.0 cutover.

## [2.10.1] — 2026-06-07

**Config consolidation.** The fast-follow to 2.10.0 relocates the scattered
*tool-agnostic* configuration into `@opensip-tools/config`, so the whole
`opensip-tools.config.yml` document is defined, validated, and templated from one
place. Hygiene + consolidation, no new behaviour beyond the strict validation
2.10.0 introduced. See
[ADR-0023](docs/decisions/ADR-0023-config-package-and-schema-registry.md) (and its
§Amendment).

> ### ⚠️ Behaviour change (pre-GA)
>
> **The document-level blocks now strict-validate too.** In 2.10.0 the
> tool-agnostic top-level blocks (`cli:`, `targets:`, `globalExcludes:`,
> `checkOverrides:`, `dashboard:`) passed through untouched; they are now claimed,
> strict namespaces in the one composed schema. A typo in those blocks (e.g. a
> target missing its `description`, or a misspelled `cli` key) now fails before a
> command runs instead of being silently dropped. Same keys, same precedence —
> only the strictness completes.

### Added

- **`no-config-loader-outside-config` architecture guardrail.** Fails CI if a
  package other than `@opensip-tools/config` hand-rolls a loader for a
  document-level config block (projecting YAML fields without routing through the
  config-owned Zod schemas). Complements `one-config-document`; together they make
  "config is parsed only in `@opensip-tools/config`" mechanically true.

### Changed

- **`contracts` is types-only again.** The `cli:` block loader
  (`loadCliDefaults` / `CliDefaults` / its schema) moved out of
  `@opensip-tools/contracts` — its runtime YAML projection was a standing
  violation of the package's types-only charter — into `@opensip-tools/config`.
- **Shared targeting is no longer owned by `fitness`.** The two-layer scope model
  (`targets` / `globalExcludes` / `checkOverrides` document shape + schemas) lives
  in `@opensip-tools/config`; `fitness` consumes it and keeps the file-resolution
  runtime (`TargetRegistry`).
- **User-global config I/O** (`~/.opensip-tools/config.yml`) and cloud-config
  resolution moved into `@opensip-tools/config`; the `configure` command's UX
  stays in the CLI and reads I/O through the package.
- **The `init` scaffold derives its document skeleton from the composed schema**
  (rendered by `@opensip-tools/config`) instead of a second, hand-written template
  that could drift from what validation accepts.

## [2.10.0] — 2026-06-07

The first two tool-plugin-parity building blocks land together: **Identity &
Compatibility** and **Capability & Configuration**. (The Identity work was
planned as 2.9.0; it merged alongside the Capability work, so both ship in this
release — there is no separate 2.9.0.) See
[ADR-0023](docs/decisions/ADR-0023-config-package-and-schema-registry.md).

> ### ⚠️ Behaviour change (pre-GA)
>
> **Config validation is now strict.** Each tool's namespace in
> `opensip-tools.config.yml` (`graph:`, `fitness:`, `simulation:`) is validated
> against a composed schema before a command runs; an **unknown key inside a tool
> block now fails** (e.g. a typo'd knob) instead of silently defaulting. Unknown
> *top-level* blocks (`cli:`, `targets:`, …) still pass through — they migrate in
> 2.10.1. CLI commands, flags, and `--json` output are otherwise unchanged.

### Added

- **Tool plugin manifest + compatibility epoch.** A static `ToolPluginManifest`
  (in `package.json#opensipTools`) the host inspects **before importing tool
  code**, with a coarse `PLUGIN_API_VERSION` gate (missing `apiVersion` is a
  grace-window v1). Bundled and external tools flow through **one** manifest
  loader + compatibility gate. Incompatible tools are skipped with a structured
  diagnostic; an explicitly-requested incompatible tool fails closed.
- **Tool trust & provenance.** Each tool's source (bundled / installed /
  project-local), identity, and manifest hash are recorded and surfaced in
  `plugin list` (human + `--json`). Project-local executable tools are
  deny-by-default (allowlist via `OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS`).
- **New `@opensip-tools/config` package (32nd publishable package).** A
  config-schema composer: each tool contributes a namespaced Zod schema; the host
  composes one whole-document schema, validates it strictly before dispatch
  (precedence: flag > env > file > defaults), and generates a JSON Schema for
  editors. (ADR-0023.)
- **Capability model.** Tools **declare** the capability domains they own in their
  manifest; the host registers them and routes contributions to the owner's
  registrar without being compiled to understand the domain. `MARKER_KINDS`
  becomes a bootstrap default that manifests extend.
- **Four new enforcement checks** (parity guardrails): `tool-has-manifest`,
  `one-config-document`, `no-module-singleton`, `capability-by-manifest`.

### Changed

- **Tool config is schema-validated.** `graph`/`fitness`/`simulation` contribute
  namespaced Zod schemas; graph's hand-projection (`projectGraphConfig`) is
  removed in favour of the composed, strict-validated schema.
- **Fitness registries are per-run (scope-owned).** The check + recipe registries
  move onto `RunScope` (matching simulation), so two concurrent runs share no
  mutable registry state. **Programmatic-API break (invisible to CLI users):** the
  `defaultRegistry` / `defaultRecipeRegistry` module singletons are removed — code
  importing them must read the scope registry instead.

### Fixed

- **`no-eval` no longer flags member calls.** `redis.eval(luaScript)` /
  `sequelize` Lua `EVAL` are no longer mistaken for JavaScript `eval()`; only a
  bare/global `eval(` is flagged.

## [2.8.0] — 2026-06-07

Recipe defaults become **tool-scoped** ([ADR-0022](docs/decisions/ADR-0022-tool-scoped-recipe-defaults.md)).
Per the pre-GA 2.x policy ([ADR-0012](docs/decisions/ADR-0012-versioning-and-release-policy.md))
this is a minor on the long-lived 2.x line. **`cli.recipe` keeps working** as a
tolerant cross-tool fallback, so most projects upgrade with no change; projects
that relied on `cli.recipe` reaching `graph`/`sim` should migrate to the
per-tool keys (see below).

### Added

- **Per-tool recipe defaults: `fitness.recipe`, `graph.recipe`, `simulation.recipe`.**
  Each tool reads its own default recipe from its own config block, because
  recipe namespaces are disjoint across tools. Resolution precedence per tool is
  `--recipe` flag > `<tool>.recipe` > deprecated `cli.recipe` > built-in `default`.
- **`cli-recipe-deprecated`** fitness check (checks-universal, `warning`) — flags
  a `cli.recipe` key and points at the per-tool replacement, driving migration.

### Changed

- **`cli.recipe` is deprecated and no longer applied to every tool.** Previously
  the tool-agnostic `cli.recipe` was merged onto every tool's `--recipe`, so a
  recipe meant for one tool leaked into the others. It is now read only as a
  **tolerant fallback**: a tool that lacks the named recipe falls back to its own
  built-in `default` (with a warning) instead of aborting. An explicit
  `--recipe <name>` typo still hard-fails (exit 2) — that guardrail is unchanged.

### Fixed

- **`opensip-tools graph` (and `sim`) no longer abort with `Unknown graph
  recipe '<name>'`** when a project sets a `fit` recipe as the (formerly
  tool-agnostic) `cli.recipe` default. Each tool now resolves its own recipe and
  tolerates a config default it doesn't recognize.

### Migration

Move any `cli.recipe` default under the owning tool's block:

```yaml
# before
cli:
  recipe: my-fit-recipe
# after
fitness:
  recipe: my-fit-recipe
```

`cli.recipe` continues to work until removed; the `cli-recipe-deprecated` check
will remind you.

## [2.7.1] — 2026-06-06

A correctness and reliability patch for the `graph` tool. **No breaking
changes** — if you run the CLI and read its output, upgrade and carry on.

### Added

- **`graph --sarif`** emits real SARIF 2.1.0 for GitHub Code Scanning, so graph
  findings surface inline on PRs the same way `fit` findings do.
- **Cross-package edge equivalence guardrail.** A CI test asserts the sharded
  build produces byte-identical edges to the single-program build on a fixture,
  so cross-package resolution can never silently regress.

### Changed

- **Graph cross-package edges are now resolved semantically.** The sharded
  engine links a cross-package call to the exact exported function via a
  per-package export-symbol table (like a linker), replacing the previous
  syntactic name-matching. Ambiguous cases **decline** (emit no edge) rather
  than guess — eliminating phantom coupling/cycle edges.
- **Inline suppression is fail-loud.** An unexpected failure reading a
  `@graph-ignore` / `@fitness-ignore` directive file now aborts the run instead
  of silently dropping the waiver (which could leak a waived finding).
  Genuinely-absent files are attributed via a structured log.

### Fixed

- **Deterministic sharded graph builds.** Workspace shard ids are now
  root-relative (`fitness/engine`, `graph/engine`) instead of a bare basename
  that collapsed nested packages to a single `engine` id and overwrote each
  other's fragment-cache row. Cold, warm, and partially-cached runs now produce
  an identical catalog (same function / entry-point counts).
- **No more false cross-package cycle errors.** Call-graph SCC nodes are now
  identified per occurrence (via `resolveCallee`) instead of by raw body-content
  hash, so two functions with identical bodies in different packages no longer
  collapse into one node and manufacture an impossible cross-package cycle.
- **Linux-only AST-check corruption** from parse-cache key collisions — the
  parse cache is now keyed by a full-content hash.

### Internal

- Vitest timeouts centralized in a shared base config, with a fitness check
  (`vitest-config-extends-base`) enforcing adoption.

## [2.7.0] — 2026-06-06

**Breaking changes in the pre-GA 2.x line.** This release makes the signal-output
model the default `--json` contract and lands the `reporting`→`output` split and
the public-surface tightening. Per
[ADR-0012](docs/decisions/ADR-0012-versioning-and-release-policy.md) the project
stays pre-GA on the long-lived 2.x major (breaking changes are batched into 2.x
minors); **`3.0.0` is reserved for the tool-plugin-parity north star**
(`docs/plans/tool-plugin-parity-architecture-2026-06-06.md`) and is not this
release.

> ### ⚠️ BREAKING CHANGES
>
> This release carries breaking changes to the machine-readable `--json` shape,
> the published package set, and the programmatic (importable) API surface. **If
> you only run the CLI and read its terminal output, nothing changes — upgrade
> and carry on.** Everyone else: read the
> **[2.7 migration guide](docs/public/70-reference/07-migrating-to-2.7.md)**.

> **Heads-up for plugin authors / `--json` consumers:** the `--json` payload, the
> `@opensip-tools/contracts` type surface, the `@opensip-tools/reporting` package
> name, the `RunScope` recipe-config slot, and the `./internal` subpath exports
> all changed. The
> [migration guide](docs/public/70-reference/07-migrating-to-2.7.md) is the
> step-by-step checklist.

### Added

- **Signals are the universal output currency (ADR-0011).** `--json` now emits a
  `SignalEnvelope` (`schemaVersion: 2`): `signals[]` + `verdict { score, passed,
  summary }` + `units[]`, identical across `fit` / `sim` / `graph`. A `fit`
  check, a `graph` rule, and a `sim` scenario are all **units** that *produce
  signals*. See the
  [JSON output schema](docs/public/70-reference/04-json-output-schema.md).
- **`@opensip-tools/tree-sitter` package (ADR-0010).** The new canonical
  tree-sitter parse substrate: wraps `web-tree-sitter` and hosts the relocated
  graph node accessors. The `lang-*` packages are now the canonical parse
  substrate; Python / Rust / Go / Java parse through `lang-*` → tree-sitter.
- **New fitness checks** `no-direct-stdout-in-tool-engine` and
  `restrict-raw-db-access`, plus new dependency-cruiser tool-output gates — they
  enforce that tools emit signals (not stdout) and never touch the raw DB
  directly (ADR-0009 / ADR-0011).
- **[2.7 migration guide](docs/public/70-reference/07-migrating-to-2.7.md)**
  under `70-reference/`.

### Changed

- **`--json` shape: `CliOutput` → `SignalEnvelope`.** The old fitness-shaped
  `CliOutput` (`version: "1.0"`, `checks[]`, `findings[]`) is replaced by the
  signal-native envelope. Severity is now the four-rung scale
  `critical | high | medium | low`, replacing `error | warning`. Full field
  mapping: [v1 → v2 mapping table](docs/public/70-reference/04-json-output-schema.md#v1--v2-mapping).
- **Tools no longer render.** Egress moved to the CLI composition root, which
  routes formatter × sink (`json` / `sarif` / `table` × file / cloud). A new
  `cli.writeSarif` file seam carries SARIF output through the root (ADR-0011).
- **Renamed package: `@opensip-tools/reporting` → `@opensip-tools/output`.** Split
  into a pure `format/` half (signal → string formatters) and an effectful
  `sink/` half (file, cloud).
- **Kernel: `recipeCheckConfig` / `RecipeCheckConfigSlot` → `recipeUnitConfig` /
  `RecipeUnitConfigSlot`** on `RunScope` — the slot serves every tool's units,
  not just fitness checks.
- **Public surface curated (ADR-0009, audit Findings 2–4).** The `./internal`
  subpath exports are no longer published, so external consumers can no longer
  import them. Graph's public barrel was curated: orchestration / CLI helpers
  moved behind `./internal`.

### Removed

- **Removed from `@opensip-tools/contracts`:** `CliOutput`, `CheckOutput`,
  `FindingOutput`, `TableRow`, `SummaryOptions` — the types that backed the old
  `CliOutput` rendering model.
- **`./internal` subpaths are no longer in the published `exports` map** of any
  package (e.g. `@opensip-tools/fitness/internal`,
  `@opensip-tools/graph/internal`). They were never a supported surface.

## [2.6.2] — 2026-06-03

OpenSIP Cloud signal sync, a two-audit remediation pass, and packaging polish.

> **Heads-up for plugin authors:** this release moves and tightens some package
> surfaces (see _Changed_). If you author a check pack, note the
> `CheckDisplayEntry` import path change below.

### Added

- **OpenSIP Cloud signal sync (ADR-0008).** With an API key and the cloud
  entitlement, each entitled `fit`/`graph` run additionally emits its signals
  to OpenSIP Cloud — additive, best-effort, never blocking or failing a run.
  Local SQLite stays the source of truth. Opt out per-run with `--no-cloud`,
  per-project with `cli.cloud.sync: false`, or machine-wide via
  `~/.opensip-tools/config.yml`. A first-run notice explains what is sent.
- **Per-package READMEs and npm `keywords`** generated for all 30 published
  packages (so npmjs.com pages render and are searchable), with `docs:readmes`
  / `docs:keywords` generators + CI sync gates.
- **ADR-0009 (public-API-surface policy)** and a `no-cross-package-internal`
  dependency-cruiser rule; capability guards that lock every tool's flag
  surface and sim's scheduler order.

### Changed

- **Public API surface tightened (ADR-0009).** Test-only engine internals moved
  behind `@opensip-tools/graph/internal` and `@opensip-tools/fitness/internal`;
  the raw session schema is package-private; leaked internal helpers were
  dropped from the fitness barrel. **Migration:** import `CheckDisplayEntry`
  from `@opensip-tools/fitness` (it moved out of `@opensip-tools/core`).
- **Update check runs hourly** instead of daily, so a newly published release
  is noticed within the hour (the detached fetch still never blocks a command).
- Docs: the modular-monolith and contract-surface concepts refreshed to match
  ADR-0007 (marker-canonical plugin discovery).

### Fixed

- **sim `--kind` no longer runs filtered-out scenarios.** It narrowed *after*
  execution, so `--kind invariant` still ran load/chaos scenarios (with their
  side effects) and merely hid them; an invalid `--kind` ran everything. Now it
  filters before execution and fails fast on an unknown kind.
- **sim `maxParallel` is honored** — the parallel scheduler was unbounded.
- **fix-evaluation surfaces as explicitly unavailable** (deferred) instead of a
  placeholder `passed: false` that looked like a real verdict.
- **Privacy: the user-level cloud opt-out is now wired.** `cloud.sync: false`
  in `~/.opensip-tools/config.yml` was read for the API key but ignored for the
  sync setting; it now disables sync (a `false` in either user or project
  config wins).
- **`fit --report-to` composes with `--json`, gate, and non-TTY (CI) runs** —
  it previously only fired in the TTY live view.
- **graph emits cloud signals in gate/report/catalog modes**, not just the
  default render (decoupled from dashboard-session persistence).
- **`configure` tests the API key** against the cloud entitlement endpoint, as
  documented, instead of only storing it.

## [2.6.1] — 2026-06-03

A discovery-hardening patch. No behavior change for normal runs beyond the
silenced warning below; the rest closes the class of bug that produced it.

### Fixed

- **Graph-adapter discovery no longer warns on shared scaffolding.**
  `opensip-tools` printed
  `graph adapter @opensip-tools/graph-adapter-common does not export a valid "adapter" — skipping`
  on every run: adapter auto-discovery matched the `@opensip-tools/graph-*`
  name prefix and swept in the shared `graph-adapter-common` library (which is
  not an adapter). Discovery now requires the `opensipTools.kind: "graph-adapter"`
  marker — mirroring tool discovery — so non-adapter packages under the prefix
  are skipped silently.
- **Dashboard: long table cells no longer bleed past the card edge.** The
  `.data-table` containment contract now wraps body cells and breaks long
  unbreakable tokens (file paths, regex, code snippets) by default, so a
  free-text column can't overrun the card and push content past the page
  boundary. Short metric columns (timestamps, durations, counts) opt out via
  `.cell-nowrap` to stay on one line; the coupling matrix keeps its own
  `.coupling-scroll` containment.

### Changed

- **Plugin discovery converges on the `opensipTools.kind` marker (ADR-0007).**
  The marker is now the canonical contract for all four plugin kinds.
  `'graph-adapter'` becomes a first-class marker kind in `core`, read through a
  single canonical reader (graph's duplicate reader is gone). First-party
  `@opensip-tools/checks-*` packs now declare `kind: "fit-pack"`, and the
  `checks-*` / `graph-*` name-prefix scans are demoted to deprecated fallbacks
  (kept for third-party backward compatibility; removal slated for the next
  major).

### Internal

- A **workspace-invariant test** asserts the plugin-kind contract at the source
  of truth — every `graph-*` / `checks-*` package declares its marker or is on
  an explicit non-plugin allowlist — so this class of discovery drift fails in
  CI rather than warning (or silently misbehaving) at runtime.

## [2.6.0] — 2026-06-03

The **symmetric tool architecture** release: the `graph` tool reaches parity
with `fitness` — rules are authored like checks (`defineRule` ↔ `defineCheck`),
selected via a shared recipe substrate, and surfaced uniformly in the dashboard.
Five new structural graph rules ship on a new engine feature layer. See
`docs/decisions/ADR-0005` (symmetric tool architecture), `ADR-0006`
(derived-data persistence), and `ADR-0001` (rule-gating bar).

### Added

- **Five structural graph rules**, each a declarative predicate over the new
  feature layer with opinionated, config-overridable thresholds:
  - `graph:large-function` — body length (warn 300 / error 500 physical lines).
  - `graph:wide-function` — parameter count (warn > 4 / error > 7).
  - `graph:high-blast-untested` — a high call-graph blast radius **and** no test
    coverage (warn ≥ 75 / error ≥ 150 blast score) — the flagship combination gate.
  - `graph:cycle` — strongly-connected-component size (cross-package → error).
  - `graph:unexpected-coupling` — package-level dependency cycles.
- **Graph recipes.** `graph --recipe <name>` selects a rule subset (default:
  all rules); `graph-recipes` (alias `list-graph-recipes`) lists them. Rules are
  authored with the new `defineRule()` factory (the `defineCheck` analogue).
- **Graph engine feature layer** — blast radius, strongly-connected components,
  package coupling, test/entry reachability, and body length are computed in the
  engine and materialized into the catalog for the dashboard to consume.
- **Dashboard:** the graph tool tab gains **Catalog** and **Recipes** subtabs;
  the topology view gains **SCC cycle highlighting**; a ranked-distribution
  function table replaces the removed single-metric tabs (see Changed).
- **Opt-in severity clamp** — `severityOverrides` in the `graph:` config clamps a
  rule's emitted severity (baseline-neutral when unset).

### Changed

- **Recipe selection is now shared (ADR-0005).** The generic recipe substrate
  (unit selection + per-unit config override) is hoisted into
  `@opensip-tools/core`; `fitness`, `simulation`, and `graph` consume it instead
  of three separate copies. No behavior change for `fit` / `sim` recipes.
- **Derived-data persistence policy (ADR-0006).** Engine-derived analyses are
  recomputed views by default, materialized into the catalog document only for
  the decoupled dashboard.
- **Dashboard graph tab restructure.** The graph tool tab is renamed **Code
  Graph** (was "Code Paths"). The single-metric explore tabs (Big, Hot, Wide,
  Untested, SCCs) are removed — those signals are now graph rules whose findings
  surface in the graph tab. The remaining explore views are consolidated: the
  **Search** subtab is folded into a searchable **Functions** view, the node-link
  **Graph** view is reworked into a package-level **Visualization**, and the
  **Coupling** matrix gains an **Export CSV** action for large repos. Per-rule
  session findings gain metric columns (lines / parameters / blast score / SCC
  size), error-before-warning sorting, and bounded overflow; a shared
  `.data-table` style now applies uniformly across every dashboard table.
- **Tree-sitter adapters → WebAssembly grammars.** The Python/Go/Rust/Java graph
  adapters and the shared adapter scaffolding migrated to vendored
  `web-tree-sitter` grammars — no native compilation at install time.
- **Tooling:** adopted **pnpm 11**; workspace settings moved to
  `pnpm-workspace.yaml`.
- The graph catalog cache payload version bumped; existing caches rebuild
  transparently on the next run (the catalog is derived state, not user data).

### Fixed

- **Dashboard Coupling CSV — formula-injection guard.** The Coupling "Export CSV"
  neutralizes any cell beginning with `=`, `+`, `-`, `@`, tab, or CR (e.g. scoped
  `@`-package names) with a leading apostrophe, so a spreadsheet cannot interpret
  untrusted package names — drawn from arbitrary analyzed repos — as formulas.
- **Graph session duration** is now the real wall-clock time (was reported as
  `0.0s`), and finding metadata is persisted so the dashboard can surface per-rule
  metric columns.
- `test-file-naming` now recognizes the `__fixtures__/` directory convention and
  dot-separated `*.fixture.ts` filenames (no longer mis-flagged as test files).
- Resolved the dogfood `fit` warnings on the new graph/dashboard code (a
  null-safety false positive, a dead export, a file-length soft-limit, and
  composition-root / bounded-collection heuristic false positives).

## [2.5.2] — 2026-06-02

### Added

- **All non-interactive CLI output now flows through the central render seam.**
  Graph's `--gate-save` / `--gate-compare`, the `--report-to` status line,
  `graph-lookup`, and the `--workspace` report previously wrote human-readable
  text straight to stdout; they now render through the same view-model seam as
  the main report (via the existing `gate-done` result and a new generic
  `graph-status` result), so their output is consistent between a TTY and a
  pipe / CI. The `--json` machine paths are unchanged.

### Changed

- **`graph` and `fit` render the static report — not the animated live view —
  when stdout is not a TTY.** The Ink live view is a TTY-only affordance; in a
  pipe, CI, or redirected run, both commands now fall through to the static
  `graph-done` / `fit-done` path, dual-rendered as plain text (the same content
  a TTY user's final frame shows). This replaces the prior behavior where the
  live view ran regardless of TTY and could emit garbled or empty frames into a
  pipe.

### Internal

- Split two over-length source files behind re-export barrels (no public API
  change): the `CommandResult` union + variant interfaces moved from
  `@opensip-tools/contracts` `types.ts` into `command-results.ts`, and the strip
  scanner primitives moved from `@opensip-tools/core` `strip-utils.ts` into
  `strip-scanners.ts`. Both files re-export the extracted half, so package
  import surfaces are unchanged.
- Hoisted the shared fitness results-table helpers (`sortFitRowPriority`,
  `parseValidatedCount`) into `@opensip-tools/cli-ui` so the live and static fit
  views share one implementation — clearing the genuine cross-package
  duplication the `graph:duplicated-function-body` watchdog flagged.

## [2.5.1] — 2026-06-02

> **Note:** `2.5.0` was never a coordinated release. Only
> `@opensip-tools/graph-adapter-common@2.5.0` was published — by the one-time
> trusted-publisher bootstrap that establishes a brand-new package name on npm
> (predating the consolidation work below). npm versions are immutable, so that
> stub can't be overwritten; `2.5.1` is the first complete, coordinated publish
> of everything in this entry.

### Added

- **New package `@opensip-tools/graph-adapter-common`** — shared tree-sitter
  adapter scaffolding (discover / parse / walk / cache-key factories) consumed
  by the Go, Java, Python, and Rust graph adapters, replacing the boilerplate
  that was duplicated across all four.
- **Deterministic cross-package duplication detector.**
  `graph:duplicated-function-body` gains an aggregate signal: a function body
  appearing in ≥ N distinct packages (`minCrossPackageDuplicatePackages`,
  default 3) is reported as a single "hoist to a shared package" finding with
  **no** per-copy size floor — surfacing small-but-widely-copied code the
  per-instance thresholds used to hide. Graph rule config is now read from a
  `graph:` block in `opensip-tools.config.yml`.
- **Per-occurrence `package` field** on `GraphFunctionOccurrence` (the nearest
  `package.json` name), so the coupling grid and rules bucket by real package
  identity. Optional / backward-compatible.

### Changed

- **The coupling grid buckets by real package, not a directory heuristic.** A
  file's package is its nearest enclosing `package.json` name, falling back to
  the top-level path segment when there's no manifest. Previously it grouped by
  the first segment under `packages/`, collapsing the workspace packages into a
  dozen directory groups and degenerating to a single `<unknown>` bucket on any
  repo not laid out under `packages/`. The grid now shows real packages and
  works on any layout (`packages/`, `apps/`+`libs/`, single-package, non-JS).
- **Graph rules are opinionated, actionable, and low-noise** (see
  `docs/decisions/ADR-0001`): a rule finding earns a gate signal only if it is
  actionable, precise, and bounded — rankings/metrics are dashboard insights,
  not gate signals. `graph:orphan-subtree` was sharpened (twin-aware
  reachability + barrel/visibility precision) from 45 false positives to zero;
  `no-side-effect-path` now skips void-returning functions (a discarded return
  value is vacuous for them) and `always-throws-branch` skips test-file
  occurrences (intentional `expect(...).toThrow()` fixtures), eliminating their
  remaining false positives; `test-only-reachable` is unchanged.
- **Blast radius is now a dashboard insight, not a gate rule.** The Hot
  Functions view ranks by the composite blast score (`direct + 0.5 ×
  transitive`); the engine no longer emits per-function blast warnings.
- **Duplicated code consolidated into shared homes:** language comment/string
  stripping → `@opensip-tools/core` `makeStripper`; plugin-discovery
  primitives → core; check-pack path/display helpers → the fitness engine;
  tree-sitter adapter helpers (`nameOf`, `skipBlockComment`,
  `isReturnValueDiscarded`) → `@opensip-tools/graph-adapter-common`; the
  `isIdentChar` predicate → core. Surfaced by `graph:duplicated-function-body`
  itself (cross-package duplicate findings 16 → 12; the remainder are
  intentional per-package twins).
- **The "update available" notice persists across runs** until you upgrade,
  instead of showing once and disappearing.

### Removed

- **`graph:high-blast-function` rule** — blast radius is now dashboard-only
  (above). _Breaking_ for anything consuming that rule's findings.
- **`BlastScore` type and `Indexes.blastRadius`** from the `@opensip-tools/graph`
  public surface. _Breaking_ for library consumers importing them.

### Fixed

- **The graph PACKAGE COUPLING grid now follows the real import graph.** It
  previously showed cross-package call edges that are impossible as imports
  (`core→fitness`, `fitness→cli`, `cli-ui→fitness`, …) — call-graph
  attribution artifacts, not real coupling. Two root causes are addressed:
  (1) a call edge's target is a content `bodyHash`, so functions with
  identical bodies in different packages collapsed to one occurrence and
  mis-attributed the callee's package — fixed with an `occurrencesByHash`
  index and a deterministic, package-aware `resolveCallee` (caller's own
  package → a package its module imports → lowest qualified name), mirrored in
  the dashboard's coupling view; and (2) name-based resolution
  (`resolveByCatalogFallback`, cross-shard recovery) linked a call to a
  globally-unique name in a package the caller never imports — fixed with a
  mode-agnostic post-resolution pass (`constrainCrossPackageEdges`) that drops
  name-guessed edges (resolution `unknown`/`dynamic-string`/`syntactic`) whose
  target isn't reachable from the caller — including builtin `.map`/`.find`
  calls mis-resolved into another package's test file — while leaving
  type-checker-backed edges untouched. No-op in `fast` mode and non-monorepo
  repos.
- **Call edges are no longer unioned across identical-bodied functions.** A
  call edge was bucketed by its owner's content `bodyHash` alone, so two
  functions with the same body in different files (e.g. `stripStrings`
  duplicated across the language adapters) shared one edge list — each then
  appeared to call every twin's callees, inventing cross-package coupling.
  Edges are now keyed per occurrence (`bodyHash` + `filePath`) end to end
  (resolver, stitch, incremental merge, dependency attach). See
  `docs/decisions/ADR-0003`.
- **Reachability rules no longer report false orphans from body-twins.** The
  `callees`/`callers` adjacency was built from the `byBodyHash`
  (last-writer-wins) collapse, erasing a losing twin's out-edges, so
  `orphan-subtree` / `test-only-reachable` BFS'd over a lossy graph. It now
  unions edges per occurrence (ADR-0003).
- **The default/interactive `graph` run now honors the project `graph:` config
  block.** The Ink live-view path built the catalog without loading config, so
  bare `graph` / `graph --verbose` silently used rule defaults while
  `graph --json` (and the gate/report paths) honored the project's `graph:`
  settings. The two disagreed (e.g. `duplicated-function-body` counts), and a
  developer's local view diverged from what CI's gate recorded. The config is
  now loaded once at the dispatch seam and threaded into both paths.

## [2.4.1] — 2026-06-01

### Changed

- **Piped / CI output is now clean plain text.** Every command's human-readable
  output is defined once as a renderer-agnostic view-model and rendered two
  ways: Ink (colored) in an interactive terminal, and plain text — **zero ANSI,
  no banner** — when stdout is piped, redirected, or running in CI. Interactive
  and non-interactive output now come from a single definition and provably
  cannot drift (enforced by a cross-renderer equivalence test). The
  `ℹ Project:` discovery line is preserved in piped output so CI logs still
  record which root was analyzed; the `--json` contract is unchanged.

### Fixed

- **`fit` / `graph` gate and report output no longer bypass the renderer.**
  The summary line, footer hints, and graph resolution caveat were previously
  hand-written to stdout in a separate code path that could drift from the
  interactive view. They now route through the shared renderer, so piped and
  interactive output are identical. Removes the hand-maintained plain-text
  duplicates in the graph CLI.
- **`performance-anti-patterns` fitness check is now accumulation-specific.**
  It flagged any spread inside a `for` body, conflating genuine O(n²)
  accumulation (`acc = [...acc, x]`, `m.set(k, [...m.get(k), x])`) with benign
  one-time spreads. Defensive copies (`[...arr].sort()`), spread call-arguments
  (`fn(...args)`), and merges (`[...a, ...b]`) are no longer false-positives —
  which also resolves a standing collision with eslint's `unicorn/prefer-spread`.

### Internal

- CI: `github/codeql-action` bumped to v4 (Node 24 runtime line).

## [2.4.0] — 2026-06-01

### Changed

- **The CLI now publishes under the unscoped name `opensip-tools`** (was
  `@opensip-tools/cli`). Install and update with a single, memorable command:

  ```bash
  npm install -g opensip-tools@latest
  ```

  This pulls the CLI **and** every bundled `@opensip-tools/*` package (language
  adapters, engine, check packs) in one shot, so updating the CLI updates
  everything in lockstep. The package name now matches the `opensip-tools`
  command and bin. The other 28 packages remain scoped `@opensip-tools/*`.

  **Migration:** `@opensip-tools/cli` is deprecated and points at
  `opensip-tools`; its last published version (2.3.3) keeps working, but new
  installs should use `npm i -g opensip-tools`. No code or config changes are
  required — the `opensip-tools` command, `opensip-tools.config.yml`, and all
  subcommands are unchanged.

## [2.3.3] — 2026-05-31

### Fixed

- **`fit` no longer warns about recognized non-code format tags.** A target's
  `languages:` field is a matching dimension that routes files to checks; only
  a subset of those tags also have a content-filter adapter (the AST-backed
  code languages). The config validator conflated "no adapter" with "unknown
  language", so legitimate adapter-less format tags — `json`, `markdown`,
  `yaml` — tripped a spurious `target config declares unknown language(s)`
  warning, even though the content filter already (correctly) scans those
  files raw. The validator now recognizes a set of non-code format tags
  (`json`, `yaml`, `markdown`, `toml`, `plaintext`) and warns only for
  genuinely unrecognized tags (e.g. a typo like `pythonn`), with a clearer
  message.

## [2.3.2] — 2026-05-31

### Changed

- **Clearer messaging when check packs are skipped for a core mismatch.** When
  a globally-installed CLI runs inside a project that vendors `@opensip-tools`
  packages, the single-core guard (2.3.1) refuses the project-local packs. That
  case now reports a single consolidated warning naming every skipped pack
  (instead of one paragraph per pack), and suppresses the misleading "install a
  checks-* package" trailer — the packs ARE installed; they were refused.
- **Mini banner refresh.** The coffee cup now reads as a branded to-go cup: the
  steam and lid render in the terminal's default foreground (≈white on dark,
  auto-contrast on light, colorless under `NO_COLOR`) while the cup body and
  saucer stay brand amber. The steam glyph is finer (`⋮`).

## [2.3.1] — 2026-05-31

A reliability fix for running a globally-installed `opensip-tools` inside a
project that also installs `@opensip-tools/*` packages.

### Fixed

- **`fit` no longer produces false positives from a split run scope.** When
  the global CLI discovered check packs from a project's `node_modules`, those
  packs loaded a second `@opensip-tools/core` instance whose `AsyncLocalStorage`
  scope differed from the CLI's. Checks then saw no active scope, so the
  content filter silently fell back to raw (unstripped) text and regex checks
  matched patterns inside string literals and comments — e.g. `console.log`
  inside a test fixture. The fit loader now **refuses any check pack that
  resolves a different `@opensip-tools/core` than the engine** (with an
  actionable warning pointing at the project-local CLI / `pnpm fit`), and the
  content filter **warns once** instead of silently degrading when no run
  scope is active. Packs that share the engine's core (the normal case) are
  unaffected.

## [2.3.0] — 2026-05-31

A compact new CLI banner with an inline upgrade prompt, two dedicated graph
export subcommands, and rounded-out OpenTelemetry tracing so the parallel
build path is observable and telemetry can never degrade a run.
Backward-compatible with 2.1.0 — all existing commands, flags, and output
are unchanged.

> **Note:** 2.2.0 and 2.2.1 were never released. 2.2.1 was a partial publish
> (only `core`/`datastore`/`contracts` reached npm before the run failed);
> those orphaned versions are superseded by 2.3.0, which publishes the full
> set consistently.

### Added

- **Compact mini banner is now the default CLI header.** A smaller banner
  shown across all commands, carrying `www.opensip.ai`. When a newer version
  is published to npm, it surfaces an inline "update available" notice with
  the exact upgrade command beneath the banner. The update-notifier no longer
  nags on a local build that is *ahead* of the published version.
- **`graph-catalog-export` and `graph-sarif-export` subcommands.** Catalog
  emission (previously reachable only as a `graph --catalog-output` mode)
  and OpenSIP-convention SARIF file output now have dedicated subcommands
  matching the `@opensip/code-intelligence` engine-subprocess contract.
  `catalog-export` takes `--catalog-output --tenant-id --repo-id --git-sha
  --run-id --mode <initial|incremental> [--changed-file …]`; `sarif-export`
  takes `--output-sarif --tenant-id --repo-id --run-id`. Existing `graph`
  usage is unaffected.
- **OpenTelemetry now covers the sharded (multi-package) build.** Previously
  only the sequential build emitted per-stage spans; multi-package builds —
  which run each package in a worker subprocess — emitted none. Core gains
  `withSpanAsync` (an async-aware span) and `currentTraceparent` (W3C context
  serialization); the shard runner propagates the parent build's trace
  context to each worker via `TRACEPARENT`, and workers emit per-stage spans
  (tagged with shard id) that nest under a parent `sharded_build` span. No-op
  unless telemetry is enabled.

### Fixed

- **Telemetry shutdown is now fail-safe.** A dead or slow OTLP collector
  could stall CLI exit (and every shard-worker subprocess) for seconds on
  the final span flush. Each export attempt and the final flush are now
  bounded by a timeout, so a broken collector degrades to "spans dropped"
  rather than a hang.
- **Telemetry's own shutdown-failure log is now a structured `evt`** (with
  `module`), so it is queryable/alertable like every other event instead of
  being buried as a bare message.
- **`graph` creates the parent directory** before writing catalog-json and
  symbol-index outputs (previously failed if the target dir did not exist).
- **`graph`/`fitness` decode child-process output across UTF-8 chunk
  boundaries.** A multi-byte character split across two pipe chunks decoded
  to replacement characters, corrupting JSON fragments and captured output;
  streams now decode through a boundary-aware `StringDecoder`.
- **The fitness/graph gate fingerprint is stable against volatile rule
  messages**, so cosmetic message changes no longer churn the baseline.

## [2.1.0] — 2026-05-30

Feature release on top of the v2 SQLite-backed platform. The headline
is a faster, parallel graph engine and an in-browser graph visualizer;
under the hood, `@opensip-tools/contracts` was purified to a types-only
package and its runtime concerns extracted into two new packages. The
`opensip-tools` CLI surface is backward-compatible with 2.0.x — the
breaking items below affect only direct consumers of the
`@opensip-tools/*` library packages.

### Added

- **Two new packages — `@opensip-tools/session-store` and
  `@opensip-tools/reporting`** (the workspace is now 29 packages).
  `session-store` owns the session SQLite schema + `SessionRepo`;
  `reporting` owns SARIF build + cloud report. Both were extracted from
  `contracts` so that `contracts` could become types-only.
- **`graph --resolution fast`** — a checker-free syntactic resolution
  tier that trades exactness for ~2× cold-build speedup. Approximate
  edges are marked as such in `graph-lookup`; rules degrade gracefully
  on approximate catalogs, and the gate refuses a fast catalog where
  exactness is required.
- **Sharded parallel graph builds.** Multi-package projects build one
  shard per package in a worker pool, recover cross-package edges in a
  boundary pass, and cache each shard fragment for incremental reuse.
- **Opt-in OpenTelemetry.** Env-gated instrumentation: the no-op API
  lives in `core`, the SDK is initialized only in `cli`, and the graph
  engine emits a per-stage span via `runStage`. Off unless explicitly
  enabled.
- **Dashboard Graph view** — an 8th Code Paths view rendering the call
  graph as a Cytoscape.js + dagre node-link diagram, with filter,
  search, and upstream/downstream impact highlighting. The renderer
  stack is vendored into the report bundle (offline-render guarantee).
- **Per-language check display metadata** for the Python, Go, Java,
  C/C++, and Rust check packs, plus `cli-ui` `Banner` `size` prop
  (`md`/`sm`) and a unified banner + project line across all commands.

### Changed

- **`@opensip-tools/contracts` is now types-only.** Its former
  drizzle/datastore runtime dependencies are gone; consumers that
  imported `SessionRepo`, the session schema, or SARIF/cloud-report
  helpers from `contracts` must now import them from
  `@opensip-tools/session-store` or `@opensip-tools/reporting`
  respectively.
- **The `CliArgs` bridge was removed** — per-command Commander options
  are the single source of truth. Tool authors reading a shared
  `CliArgs` object should read their own command's options instead.
- **The dependency-cruiser architecture gate is now live.** Cross-package
  layer rules are enforced against resolved paths (not inert), with an
  ESLint barrel-only rule for core imports in check packs and a
  gate-liveness guard wired into `pnpm lint`.

### Fixed

- Resolved all 30 dogfood `fit` warnings across fitness, graph,
  dashboard, and core.
- Fixed an OOM in the dashboard end-to-end integration test (boot-once +
  lazy graph mount).
- Wired the `graph-go` and `graph-java` adapters into the CLI and made
  the adapter guardrails pattern-based.

## [2.0.1] — 2026-05-29

Republish of the 2.0.0 feature set from a single consistent build. No
source behavior changes — this release exists only to repair a broken
2.0.0 publish.

### Fixed

- **`opensip-tools` crashed on startup under 2.0.0** with
  `SyntaxError: The requested module '@opensip-tools/cli-ui' does not
  provide an export named 'RunFooterHints'`. The 2.0.0 release was
  non-atomic: `@opensip-tools/cli-ui@2.0.0` was published from an
  earlier build that predated the `RunFooterHints` export, while
  `@opensip-tools/fitness@2.0.0` (published ~11h later) imported it.
  Because npm package versions are immutable, the stale `cli-ui` tarball
  could not be overwritten in place. 2.0.1 republishes all 27
  `@opensip-tools/*` packages together from one clean build, restoring a
  consistent inter-package export contract. **Anyone on 2.0.0 should
  upgrade: `npm install -g @opensip-tools/cli@2.0.1`.**

## [2.0.0] — 2026-05-28

Persistence migration: every internal runtime artifact (sessions, graph
catalog, graph + fitness baselines) moves from JSON files to SQLite
behind a unified `DataStore` abstraction. The full plan and decision
log live under [`docs/plans/persistence-migration/`](docs/plans/persistence-migration/).

This release introduces one new package, swaps storage on three tools,
and breaks compatibility with v1.x runtime layouts.

### Breaking changes

- **`opensip-tools uninstall --project` no longer destroys user-authored
  content by default.** The new default removes only
  `<project>/opensip-tools/.runtime/` (rebuildable state). User-authored
  content under `opensip-tools/` (custom checks, recipes, scenarios) AND
  `opensip-tools.config.yml` are preserved. To restore the previous
  destructive behavior, pass `--purge`. Rationale: the previous default
  was actively dangerous — the warning copy literally said "git history
  is your safety net," which is hope, not a contract.
- **`ToolCliContext.datastore` is now a getter that opens SQLite lazily
  on first access (was an always-open handle).** Tool authors don't need
  changes — `ctx.datastore` still reads as a property — but the
  `BootstrapResult.datastore` field is gone and `bootstrapCli` returns
  `void`. The CLI no longer materializes `.runtime/datastore.sqlite` until
  a tool action body actually reads `cli.datastore`. Dry-runs, errors,
  and commands that don't need persistence leave the filesystem clean.
- **`ToolCliContext` gains a required `project: ProjectContext` field**
  carrying the resolved project root, configPath, walkedUp count, and
  scope. Tools that construct a ToolCliContext literal must provide it.
  First-party tools (fitness, simulation, graph) are migrated; third-
  party tool authors should read `cli.project.projectRoot` in action
  bodies instead of `opts.cwd`.
- **`ToolCliContext.maybeOpenDashboard` opts no longer accept `cwd`.**
  The dashboard helper reads the project root from `ProjectContext`
  directly. Callers passing `cwd` will fail to compile; remove the field.
- **`opensip-tools` commands now discover the project root by walking up
  from cwd.** Running `opensip-tools fit` from a subdirectory of an
  initialized project operates on the parent project root, not the
  subdirectory. This fixes a phantom-scaffold bug where commands run
  from subdirs silently created a second `opensip-tools/.runtime/`
  inside the subdir. `opensip-tools init` refuses with an actionable
  three-option message when invoked from inside an existing project —
  use `--cwd .` to override (rare; intended for monorepo packages with
  independent analysis scope).
- **`opensip-tools` errors with "No opensip-tools project found"
  (exit 2) when project-scoped commands run with no config anywhere up
  the ancestor chain.** Previously these would attempt to run and fail
  later with a config-load error. Affected commands: `fit`, `sim`,
  `graph`, `dashboard`, `sessions`, `plugin`. Project-agnostic commands
  (`init`, `configure`, `completion`, `uninstall`) are unchanged.
- **`RunHeader` prop renamed from `cwd` to `projectRoot` (cli-ui)** to
  align with the resolved-root semantics. The visible string changed
  from `Target: <cwd>` to `Project: <projectRoot>` (with an optional
  `(found N levels up)` suffix). Third-party tools that import
  `RunHeader` from `@opensip-tools/cli-ui` must rename the prop.
- **Runtime state migrates from JSON files to SQLite.** v2 ignores any
  pre-existing files under `<project>/opensip-tools/.runtime/` and
  initializes a fresh `<project>/opensip-tools/.runtime/datastore.sqlite`
  on first run. Caches rebuild automatically; **session history from
  v1.x is not preserved**. Users who need the old layout should pin to
  v1.x.
- **`--baseline <path>` flag removed from `opensip-tools fit`.** The
  baseline is now a single SQLite-backed row per project; the flag has
  no equivalent. Drop `--baseline path/to/file.sarif` from CI
  invocations. The default location of the SARIF baseline (previously
  `opensip-tools/.runtime/baseline.sarif`) is now embedded as a row in
  the project's `datastore.sqlite`. Same for the graph baseline (was
  `opensip-tools/.runtime/cache/graph/baseline.json`).
- **`configurePersistencePaths` removed from
  `@opensip-tools/contracts`.** This was an internal API used by the
  CLI bootstrap and a small number of tests; replaced by passing a
  `DataStore` through `ToolCliContext`. External consumers who reached
  for it should switch to constructing a `SessionRepo` over the
  context's `datastore` field.
- **`context-mutation-check` slug renamed to `context-mutation`** to
  match the post-Phase-D1 single-concern file shape. Users with
  `--check context-mutation-check` in CI invocations or recipes must
  update to `--check context-mutation`. No alias.
- **`PluginResult` discriminator lifted to `type`.** Plugin command
  results now use `type: 'plugin-list' | 'plugin-add' | 'plugin-remove'
  | 'plugin-sync'` directly, instead of `type: 'plugin'` with an inner
  `action` field. External consumers of `--json` output that switch on
  `result.type === 'plugin'` must update to one of the four new literals.

### Added

- **`fit-baseline-export` and `graph-baseline-export` subcommands** read
  the SQLite-backed gate baseline and write it to a file on disk. The
  underlying baseline moved from `<runtime>/baseline.sarif` (fit) and
  `<runtime>/cache/graph/baseline.json` (graph) into the SQLite
  datastore in the v2 persistence migration; these subcommands let CI
  flows (e.g. `gh code-scanning upload-sarif`) and git-tracked-baseline
  workflows continue to consume the file shape without reading the
  datastore directly. Usage:
  ```
  opensip-tools fit-baseline-export --out path/to/baseline.sarif
  opensip-tools graph-baseline-export --out path/to/baseline.json
  ```
  Parent directories of `--out` are created if missing; the file is
  overwritten if present. Exits 2 when no baseline has been captured
  yet (run `--gate-save` first).
- **Marker-based plugin discovery** — fit and sim packs can now declare
  `opensipTools.kind: "fit-pack"` (or `"sim-pack"`) in their `package.json`
  and be auto-discovered regardless of npm scope or name. Mirrors the
  existing tool-plugin marker pattern (`kind: "tool"`). The generic
  walker lives in `@opensip-tools/core` as `discoverPackagesByMarker`,
  parameterized by the kind value; fit's `loadDiscoveredCheckPackages`
  and sim's `loadDiscoveredScenarioPackages` call it alongside their
  existing name-pattern walks, deduping by package name. Existing
  `@opensip-tools/checks-*` / `@opensip-tools/scenarios-*` discovery
  continues working unchanged.
- **Fit auto-discovery now loads `mod.recipes`** from discovered check
  packs — previously dropped silently. The `cli.check_package.loaded`
  log event carries a new `recipesRegistered` field. Sim's equivalent
  already loaded recipes; this brings the two domains into symmetry.
- **Shared `registerRecipesFromMod` helper in core** — single
  implementation of the "iterate `mod.recipes`, shape-check, register"
  pattern previously near-duplicated across three sites (fitness plugin
  loader, fit CLI, sim CLI). Emits `plugin.recipe.invalid_item` warnings
  on malformed recipes (previously: sim silently dropped them).
- **Project-root discovery** — `resolveProjectContext` in
  `@opensip-tools/core` walks ancestors looking for
  `opensip-tools.config.yml` (honoring `package.json#opensip-tools.configPath`
  at each level). The resolved `ProjectContext` is threaded through
  `ToolCliContext.project` and `opts.projectContext` so every command
  operates on the right root regardless of which directory the user
  invokes from.
- **`opensip-tools uninstall --purge` flag** for the destructive uninstall
  mode (removes user content + config alongside runtime).
- **`ℹ Project: <root>` header** printed before every project-scoped,
  human-readable command (or rendered by `RunHeader` for Ink-rendered
  commands). Annotation `(found N levels up)` when discovery walked.
  Suppressed for `--json`, `completion`, `--help`, `--version`,
  user-scoped commands, and `uninstall --project` (whose printer owns
  its own pre-prompt block).
- **Strict `--config` errors** — `opensip-tools <cmd> --config /typo.yml`
  now errors with the structured `ValidationError` instead of silently
  walking up to find some other ancestor's config.
- **`@opensip-tools/datastore` package** — paradigm-agnostic SQLite +
  Drizzle persistence layer. Houses the `DataStore` interface, SQLite
  + in-memory backends, factory, and the workspace-wide migration
  store (`migrations/`). Tools own their domain schemas (sessions in
  contracts; baseline/catalog in graph; baseline in fitness).
- **`@opensip-tools/dashboard` package** — extracted from contracts
  (see Changed). Holds `generateDashboardHtml`, the `DashboardInput`
  options shape, the ranked-view template, and the tab activator
  registry.
- **`ToolCliContext.datastore`** — every tool plugin now receives a
  per-process `DataStore` handle for its persistence work. Built-in
  tools use it via the relevant repo class (`SessionRepo`,
  `GraphBaselineRepo`, `CatalogRepo`, `FitBaselineRepo`).
- **`ToolCliContext.registerLiveView`** — registration-style API for
  tools to contribute a live view. Replaces the leaky
  `renderLive(viewKey, args)` switch in the CLI dispatcher; the CLI
  no longer hardcodes `'fit'`/`'graph'` view keys. `renderLive` throws
  a typed `UnknownLiveViewError` on miss.
- **`ToolCliContext.emitJson(value)`** — single seam for tools to
  print JSON output. Removes six identical
  `process.stdout.write(JSON.stringify(...))` sites across fitness,
  simulation, and graph.
- **`Logger` interface + `LoggerImpl` class re-exported from
  `@opensip-tools/core`.** Tools can substitute their own logger in
  tests; production code keeps the singleton via the existing
  re-exports.
- **`LanguageParseCache` re-exported from `@opensip-tools/core`.**
  Public type, with a `dispose()` method for test isolation.
- **`CliProgram` re-exported from `@opensip-tools/contracts`.** Tool
  packages can drop `as Command` casts in `register(cli)` and accept
  a typed `cli: CliProgram` parameter without taking a direct
  `commander` dependency. The alias is type-only.
- **`defineRegexListCheck` Template helper in `@opensip-tools/fitness`.**
  Collapses the per-line, per-pattern violation-emit loop into a
  declarative config. Adopted at five `checks-universal` sites
  (`no-console-log`, `no-window-alert`, `no-eval`, `no-ai-attribution`,
  `no-process-artifacts`).
- **`opensip-tools init --keep` and `--remove`.** Two explicit flags
  for the partial-state cases (config XOR `opensip-tools/` directory
  present, or directory contents don't match a fresh-init scaffold).
  Default refuses with a clear message; flags express user intent.
  `InitResult.preExistingFiles[]` and `InitResult.partialStateError`
  surface what's there.
- **Automatic schema migrations.** `DataStoreFactory.open()` applies
  any pending Drizzle migrations on every CLI invocation; users see no
  extra step. Migrations are content-hashed and idempotent.

### Changed

- **Fitness dashboard reads the graph catalog from SQLite, not disk.**
  `loadGraphCatalog` in `packages/fitness/engine/src/cli/dashboard.ts`
  was still reading the legacy `<runtime>/cache/graph/catalog.json`
  file, which the v2 graph migration stopped writing. The dashboard's
  Code Paths panel rendered in a no-data state for every project on
  v2 as a result. The fix queries the `graph_catalog` table directly
  via raw SQL (importing `CatalogRepo` from `@opensip-tools/graph`
  would create a build cycle since graph already depends on fitness
  for SARIF helpers — DEC-3).
- **`@opensip-tools/contracts`** gains `SessionRepo` and the sessions
  schema. `StoredSession` shape is unchanged; layout shifts from
  one-JSON-per-run files to `sessions` + `session_checks` +
  `session_findings` rows.
- **`@opensip-tools/graph`** loads/saves the call-graph catalog and
  the gate baseline through `CatalogRepo` and `GraphBaselineRepo`.
  Catalog write is whole-replace at end of pipeline; the cached read
  shape is identical to v1's (`Catalog` value with the same fields),
  so dashboard view derivations and rules are unchanged. Performance
  is at parity; per-package incremental writes and view-targeted
  queries land in a follow-up `graph-catalog-perf` plan.
- **`@opensip-tools/fitness`** stores the SARIF gate baseline in
  `fit_baseline` (single row). The hash-based diff algorithm
  (`extractViolationsFromSarif`/`extractViolationsFromCliOutput`) is
  unchanged; only the I/O moves. The fitness file-cache stays as v1's
  in-process `Map<string, string>` — it is per-run only, not
  persistent, so no migration applies.
- **Dashboard renderer extracted to `@opensip-tools/dashboard`.**
  The renderer subtree previously living under
  `packages/contracts/src/persistence/dashboard/` moves to its own
  workspace package at Layer 3. `contracts` no longer contains
  dashboard runtime code; fitness imports `generateDashboardHtml` from
  the new package. Workspace expands to 19+ packages.
- **`generateDashboardHtml` is now an options-object call.** The
  legacy positional signature
  (`generateDashboardHtml(sessions, checkCatalog, recipeCatalog,
  graphCatalog, editorProtocol)`) is gone; the new signature is
  `generateDashboardHtml({ sessions, checkCatalog?, recipeCatalog?,
  graphCatalog?, editorProtocol? })`. `DashboardInput` is exported
  from the package barrel so future tool-shaped data extends the
  interface instead of growing positional parameters.
- **Dashboard ranked views adopt a shared `defineRankedView` helper.**
  The four ranked views (`hot`, `big`, `wide`, `untested`) now each
  consist of ~30 lines of declarative config — the rank-and-render
  skeleton lives in `code-paths/view-template.ts`. Rendered HTML is
  byte-comparable to the previous form; no behavior change.
- **Cross-tab navigation uses a `tabActivators` registry.** The
  Overview tab no longer references `openCodePathsSession` by name;
  it asks the registry via `activateTabForSession(s)`. Session-aware
  tabs register their activators via `registerTabActivator(key, fn)`.
- **`opensip-tools init` flag rename.** `--force` is removed;
  replaced by `--keep` (re-scaffold examples, preserve custom files)
  and `--remove` (delete `opensip-tools/` entirely, then scaffold
  fresh). Default refuses on partial state with a clear flag hint.
  Migration: `--force` → `--remove` (closest semantic match — it
  overwrote everything).

### Deprecated

- **`plugins.packageScopes` soft-deprecated in docs.** The mechanism
  itself stays in code (existing customers using it continue to work
  unchanged), but the plugin-authoring doc now recommends the marker
  pattern (`opensipTools.kind: "fit-pack"` / `"sim-pack"`) for new
  packs. `packageScopes` is now framed as a compatibility shim for
  legacy third-party packs that follow `@scope/checks-*` naming
  conventions without declaring the marker. See
  [`docs/public/50-extend/01-plugin-authoring.md`](docs/public/50-extend/01-plugin-authoring.md).
- **`CliArgs` from `@opensip-tools/contracts` is deprecated for new
  flags.** The interface still works (`*OptsToCliArgs` adapter
  functions in `@opensip-tools/fitness`, `@opensip-tools/simulation`,
  and the CLI's `init` command remain in place), but new command flags
  should land on the per-command options interfaces — `FitOptions`,
  `ToolOptions`, `InitOptions` — rather than on `CliArgs`. The
  `@deprecated` JSDoc tag now surfaces this in IDE tooltips. See
  `docs/public/50-extend/01-plugin-authoring.md` for the
  adapter pattern.

### Removed

- **`ProjectPaths.baselinePath` and `graphBaselinePath`.** Orphaned after
  the v2 persistence migration: fit's gate baseline lives in the
  `fit_baseline` table (via `FitBaselineRepo`); graph's lives in
  `graph_baseline_signals` + `graph_baseline_meta` (via
  `GraphBaselineRepo`). No consumer reads from the legacy file paths,
  so the path-resolver entries are gone. External consumers needing a
  file artifact should use the new `fit-baseline-export` /
  `graph-baseline-export` subcommands.
- **`ProjectPaths.graphCatalogPath`.** Same shape — the catalog moved
  to `graph_catalog` (via `CatalogRepo`), and the dashboard fix in
  this release was the last consumer reading the legacy file path.
- **`metadata` plugin export contract.** The `metadata?: PluginMetadata`
  field on `FitPluginExports` / `SimPluginExports` / `LangPluginExports`,
  and the `PluginMetadata` interface itself, were dead code — no consumer
  site read them, and every field (`name`, `version`, `description`,
  etc.) duplicated `package.json` which is already read separately via
  `readCheckPackageMetadata`. Removed wholesale; first-party check packs
  (`@opensip-tools/checks-typescript`, `-universal`, `-python`, `-go`,
  `-java`, `-cpp`, `-rust`) had their `export const metadata` blocks
  removed. Third-party packs still exporting `metadata` continue to work
  (the field is silently ignored at load time); they can remove it at
  their leisure. If a future pack-catalog UX needs richer metadata, it
  will get a purpose-built design.
- **`packages/graph/engine/src/cache/{read,write,normalize}.ts`** — the
  streamed JSON catalog reader/writer. Replaced by `CatalogRepo`.
- **`@opensip-tools/contracts` exports**: `configurePersistencePaths`,
  `saveSession`, `loadSessions`, `loadLatestSession`, `countSessions`,
  `clearAllSessions`, `clearSessionsOlderThan`, `getStoreDir`,
  `getReportsDir`. Replaced by `SessionRepo`.
- **`DEFAULT_BASELINE_PATH`** and the `--baseline <path>` flag from
  fitness (see Breaking changes).
- **Five umbrella `checks-universal` checks** consolidated in the
  audit-remediation pass: `comment-quality`, `dependency-security-audit`
  (renamed `dependency-vulnerability-audit`), `no-legacy-code`,
  `no-test-only-skip`, and `todo-comments` (TS variant). Their content
  was either split into focused single-concern checks
  (`no-ai-attribution`, `no-process-artifacts`, `no-deprecated-tags`,
  `no-compatibility-layer-names`, `no-temporary-workarounds`) or folded
  into the cross-language equivalent (`no-todo-comments`,
  `no-focused-tests`, `no-skipped-tests`).
- **`async-patterns.ts` and `context-safety.ts`** in
  `checks-typescript/resilience/` — split into one-check-per-file
  (`detached-promises`, `no-unbounded-concurrency`, `no-raw-fetch`,
  `await-result-unwrap`, `context-mutation`, `context-leakage`).
- **`InitOptions.force`** replaced by `keep` and `remove` (see Added).

### Upgrade path

- **v1.x → v2.0.0**: re-run `opensip-tools fit --gate-save` to
  re-establish the architecture-gate baseline; the rest is automatic.
  Drop `--baseline <path>` from any CI invocations.
- **v2.x → v2.y** (future minor releases): first run of the new
  version applies any pending Drizzle migrations on top of the
  existing `datastore.sqlite`. Users see no extra step. Downgrades
  across schema changes are unsupported and produce a
  `DataStoreMigrationError` on next run; recovery is to delete
  `<project>/opensip-tools/.runtime/datastore.sqlite` (cache rebuilds;
  session history lost).

## [1.3.1] — 2026-05-18

Maintenance release. Clears the `glob@11.1.0` deprecation warning that
surfaced on `npm install -g @opensip-tools/cli` by bumping the
first-party `glob` dependency to the current major. No behavioral or
API changes.

### Changed

- **`glob` bumped from `^11.0.0` to `^13.0.0`** in
  `@opensip-tools/fitness` and `@opensip-tools/graph`. Both packages
  use only the stable `glob` / `globSync` named exports, so the
  upgrade is drop-in. The previous `glob@11.x` major was deprecated
  upstream by npm; v13 is the current release line.

## [1.3.0] — 2026-05-18

Language pluggability for `@opensip-tools/graph`. Implements [plan
10](docs/plans/10-graph-language-pluggability.md) end-to-end (PRs
2-6): the graph engine is no longer TypeScript-only. A new
`GraphLanguageAdapter` contract lets any language pack participate;
Python and Rust adapters ship as the first two non-TypeScript
implementations. The TypeScript adapter is unchanged in behavior —
catalog output is byte-identical pre vs. post refactor.

### Added

- **Python adapter** (`@opensip-tools/graph` ships it first-party).
  Tree-sitter parser, name-based call resolution, file discovery
  via `pyproject.toml` / `setup.py` with `**/*.py` glob fallback.
  Emits function/method/lambda + module-init occurrences.
  Per-rule fidelity: medium for `orphan-subtree` and
  `duplicated-function-body`, low for `no-side-effect-path` and
  `test-only-reachable`, medium for `always-throws-branch`.
  Detected automatically when a project has more `.py` than `.ts`
  files; `pickAdapter()` resolves ties by language preference (TS
  > Python > Rust).

- **Rust adapter**. Tree-sitter parser, name-based + impl-block
  context for method receivers. File discovery via `Cargo.toml`
  with `**/*.rs` glob fallback. Handles `fn`, `impl` methods,
  closures, `macro_invocation` as calls. Same fidelity tier as
  Python.

- **`GraphLanguageAdapter` contract** under
  [`packages/graph/engine/src/lang-adapter/`](packages/graph/engine/src/lang-adapter/).
  Six methods (`discoverFiles`, `parseProject`, `walkProject`,
  `resolveCallSites`, `cacheKey`, optional `ruleHints`) plus three
  identity fields (`id`, `fileExtensions`, `displayName`). Nine
  behavioral invariants (I-1 through I-9) validated by a contract
  test suite that runs against every registered adapter.

- **Contributor authoring guide**:
  [`docs/public/40-graph/03-adding-a-language.md`](docs/public/40-graph/03-adding-a-language.md).
  Walks a contributor through implementing a new adapter against
  the contract test suite. Includes a per-rule fidelity matrix and
  a first-PR checklist.

### Changed

- **Graph catalog format bumped to v3.** The TypeScript-specific
  `tsConfigPath` and `tsCompilerVersion` fields are replaced with
  `language: string` (the adapter id) and `cacheKey: string` (an
  opaque per-adapter invalidation key). v2 catalogs invalidate
  gracefully; users see one cold rebuild on upgrade.

- **Engine code is now language-agnostic.** Everything under
  `packages/graph/engine/src/pipeline/`, `cache/`, `rules/`,
  `render/`, and `cli/` (except `bootstrap.ts` and the
  scope-resolution helpers) is generic over `GraphLanguageAdapter`.
  TypeScript-specific code lives entirely under
  [`packages/graph/engine/src/lang-typescript/`](packages/graph/engine/src/lang-typescript/);
  Python under `lang-python/`; Rust under `lang-rust/`.

### Internal

- New module: [`packages/graph/engine/src/lang-adapter/`](packages/graph/engine/src/lang-adapter/)
  (interface, registry, shared edge helpers).
- New module: [`packages/graph/engine/src/lang-typescript/`](packages/graph/engine/src/lang-typescript/)
  (TypeScript adapter — code-moved from `pipeline/`, then wrapped
  in the contract).
- New module: [`packages/graph/engine/src/lang-python/`](packages/graph/engine/src/lang-python/)
  (Python adapter, ~8 source files + fixture).
- New module: [`packages/graph/engine/src/lang-rust/`](packages/graph/engine/src/lang-rust/)
  (Rust adapter, ~8 source files + fixture).
- `bootstrap.ts` registers the three first-party adapters at
  module load. Imported by `tool.ts` (Tool plugin entry) and
  `cli/orchestrate.ts` (so direct `runGraph()` callers in tests
  don't need to register manually).
- New tests: 39 contract tests in
  [`__tests__/lang-adapter-contract.test.ts`](packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts)
  (13 invariants × 3 languages). New `lang-adapter-registry.test.ts`
  validates `pickAdapter()` ties.
- `pickAdapter(cwd?)` now does file-extension dominance counting
  with a deterministic preference list (TS > Python > Rust on
  ties). Necessary once two non-TS adapters were registered.
- `lang-adapter/edge-helpers.ts:appendEdge` extracted because the
  duplicated-function-body rule legitimately fired across the
  three adapters' near-identical helpers.
- New dep-cruiser rules:
  `graph-no-typescript-import-outside-lang-typescript`,
  `graph-no-tree-sitter-import-outside-lang-packs`,
  `graph-pipeline-no-lang-import`,
  `graph-orchestrate-no-direct-lang-import`. The TypeScript-import
  rule is also enforced by ESLint's `no-restricted-imports`
  because dep-cruiser cannot observe `node_modules` edges under
  this project's `tsPreCompilationDeps: false` setting.

### Trade-offs

- Cross-package call sites in `--package` / `--packages` mode and
  cross-language graphs are still single-language per project. A
  TS file calling a WASM-built Rust function produces two separate
  graphs.
- Python and Rust resolution is name-based, not type-aware.
  `getSymbolAtLocation`-grade fidelity for those languages would
  require integrating an LSP server (jedi/pyright for Python,
  rust-analyzer for Rust); deferred per [plan 10
  §1](docs/plans/10-graph-language-pluggability.md) non-goals.
  The `CallEdge.confidence` field carries the fidelity tier so
  rule consumers can degrade gracefully.

## [1.2.0] — 2026-05-18

A performance-focused release for `@opensip-tools/graph`. Implements
[`docs/plans/00-graph-performance-improvements.md`](docs/plans/00-graph-performance-improvements.md)
waves 1–4. Driven by an OpenSIP measurement run (5476 files) that
OOM'd Node's default 4 GB heap and took ~25 minutes under a 12 GB
heap.

### Added

- **`graph --packages`** — fan a graph run across every workspace
  package under `packages/**` with a `tsconfig.json`. One child
  process per package, concurrency capped at `cpus()-1`. Aggregates
  per-package findings into a unified report. On the opensip-tools
  self-graph (18 packages), a parallel run is ~2.3× faster than the
  global run with no fidelity change. `--packages-concurrency <n>`
  overrides the cap.

- **`graph --package <name|path>`** — scope a graph run to a single
  workspace package's tsconfig. Per-package runs typically complete
  in seconds and fit in the default Node heap; cross-package call
  sites become unresolved (lower fidelity, much faster). Searches
  `packages/**` for a basename match, or accepts an explicit
  directory path.

- **Heap-sizing hint at startup** — when `discoverFiles` returns
  more than 1000 files, `graph` emits a one-line stderr hint
  recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher
  for very large monorepos). Below the threshold, silent.

### Changed

- **`graph` stage 1+2 fused into a single AST walk per file**
  ([`packages/graph/engine/src/pipeline/walk.ts`](packages/graph/engine/src/pipeline/walk.ts)).
  Legacy pipeline walked every file twice — once to emit function
  occurrences, once to find and resolve call sites. The unified walk
  emits both in one descent and feeds the call-site list to
  `resolveEdgesFromRecords` for resolver dispatch. Eliminates the
  redundant `hashFunctionBody` calls Stage 2's `hashOf` previously
  performed on every function-shape. Catalog output is byte-identical
  to the pre-refactor pipeline.

- **`graph` cache is now incrementally updated.** Previous behaviour
  was binary: any file change → full rebuild. New behaviour:
  `classifyCatalog` returns `valid | incremental | invalid`; on
  `incremental`, the orchestrator re-walks only the changed files
  plus their transitive edge-dependents and merges with cached
  entries from unchanged files. Iterates to fixpoint so no cached
  edge dangles. Editing a single file in the opensip-tools self-
  graph drops rebuild time from ~15 s (full) to ~2.5 s (incremental,
  ~6×) with byte-identical output. `--no-cache` still forces a full
  rebuild.

- **Streamed catalog write** — `cache/write.ts` emits the catalog
  metadata via `JSON.stringify` with a sentinel placeholder for the
  `functions` field, then writes the functions map entry-by-entry
  via `writeSync`. Bounds the write peak by the largest single
  occurrence array rather than the full catalog. Output is
  byte-identical to the legacy `JSON.stringify(_, null, 2)` path so
  existing on-disk caches stay valid.

- **Slice-not-getText for body hashing** — `digestFunctionBody` uses
  `sourceFile.text.slice(start, end)` instead of
  `node.getText(sourceFile)`, avoiding the per-call AST walk that
  materialises a fresh string. Identical hash output.

- **TypeScript `Program` is freed before serialization** —
  orchestrator's stage 1+2 work is scoped so the program reference
  becomes unreachable as soon as edge resolution returns. With
  ~3000+ files the program plus its bound symbol table is ~1–2 GB;
  freeing it before stages 3–5 (indexes, rules, serialization) keeps
  peak resident lower.

### Internal

- New module: [`packages/graph/engine/src/pipeline/walk.ts`](packages/graph/engine/src/pipeline/walk.ts)
  (unified Stage 1+2 walk).
- New module: [`packages/graph/engine/src/cli/scope.ts`](packages/graph/engine/src/cli/scope.ts)
  (`--package` and workspace-discovery resolution).
- New module: [`packages/graph/engine/src/cli/packages-runner.ts`](packages/graph/engine/src/cli/packages-runner.ts)
  (`--packages` parallel runner).
- `cache/invalidate.ts` gains `classifyCatalog` and `diffFingerprints`;
  `isCatalogValid` retained as a back-compat boolean wrapper.
- `cli/orchestrate.ts` gains `obtainCatalog` (cache verdict
  dispatch), `buildAndResolveCatalogIncremental` (Wave 4),
  `expandClosureToFixpoint`, `mergeOccurrences`, and
  `restoreCachedCalls`.
- Phase 5 (lazy typechecker init) was spiked and rejected: the
  apparent ~12× speedup was an artefact of stale-cache comparison
  and the binder cost simply shifts to Stage 2's first
  `getSymbolAtLocation` call. Eager `program.getTypeChecker()` in
  Stage 1 is retained.
- Architecture docs updated under [`docs/public/40-graph/`](docs/public/40-graph/)
  and [`docs/public/70-reference/01-cli-commands.md`](docs/public/70-reference/01-cli-commands.md)
  to reflect the fused walk, incremental rebuild, `--package` /
  `--packages`, and updated catalog shape (`bodySize`,
  `discarded`). Dead links to retired plan docs (`graph-tool-v2-design`,
  `graph-rule-enhancements`, `graph-dashboard-v3-design`,
  `tool-version-from-package-json`) replaced with live references.

## [1.1.0] — 2026-05-17

> **DRAFT — please review and rewrite the framing before tagging.** The
> lead bullet under _Added_ should reflect how you want users to
> perceive `@opensip-tools/graph`: as a first-class third tool, or
> still flagged experimental like `sim` has been.

### Added

- **`@opensip-tools/graph` — new tool package**, the third first-party
  Tool alongside `fit` and `sim`. Static call-graph + dead-end analysis
  with a six-stage staged pipeline and an interactive HTML dashboard
  (`graph dashboard`). Dashboard views shipped: Function Card overlay,
  fuzzy Search, Hot Functions, Big/Wide functions, Untested, SCCs
  (Tarjan), Coupling heat map, plus collapsible filter chips, hash
  routing, editor deep-links from entry, and a slide-out per-tab help
  drawer. Initial gate baseline is committed at
  `opensip-tools/graph/baseline.json` so the tool can gate itself in CI
  from day one.

- **Coverage gate at ≥90%** across the engine and language packs:
  `@opensip-tools/core`, `fitness`, `simulation`, `graph`, `lang-rust`,
  `checks-typescript`, `checks-universal`, and exported helpers in
  `checks-{cpp,go,java,python}`. Exercises previously-uncovered
  exported surfaces, not synthetic coverage padding.

### Fixed

- **`defineRecipe` is now exported from `@opensip-tools/fitness`.**
  The helper was used internally but never re-exported through the
  package barrel, blocking out-of-tree recipe authors. The
  `chaos-executor` doc reference was corrected at the same time.

- **Tool `metadata.version` no longer drifts from package.json.**
  All three first-party Tools (`fitness`, `simulation`, `graph`) now
  read their version from package.json at module-load time via a new
  `readPackageVersion(import.meta.url)` helper exported from
  `@opensip-tools/core`. Previously the version was a hardcoded
  literal in each `tool.ts`; `fitness` and `simulation` reported
  `'1.0.0'` through several releases because nothing forced a sync
  on bump. `fitness` and `simulation` now have contract tests
  matching `graph`'s, so drift is caught at test time rather than at
  release time. Implements the proposal in
  `docs/plans/tool-version-from-package-json.md`.

### Internal

- Architecture-doc audit completed across passes 15–21 (worktree-arch-
  audit branch merged). Fixes include: stale section path refs, stale
  17-package counts, per-language pack contents accuracy, README
  headings + `configuration.apiKey` + plugin-loader `projectDir`
  surfaces, ignore-directive comment forms, paginated (not capped) Code
  Paths views, invariant scenarios documented as workflow integration
  (not property-based), and lang-rust adapter description.
- Release plumbing updated for the third tool: `RELEASING.md`,
  `.github/workflows/release.yml` (preflight, pack, publish steps),
  and `tools/bootstrap-publish.sh` now account for 18 packages
  including `@opensip-tools/graph`.

## [1.0.10] — 2026-05-16

### Added

- **`opensip-tools uninstall --project [path]`** — project-local
  cleanup. Removes both `<path>/opensip-tools/` (user-authored checks +
  recipes and the gitignored `.runtime/` cache) and
  `<path>/opensip-tools.config.yml`. Path defaults to cwd; pass
  `--project /path/to/repo` to target another location. Refuses to run
  when neither target exists at the resolved path, so an accidental
  `--project /unrelated/dir` is a no-op rather than a destructive
  accident. Both modes support `--dry-run` and `--yes`.

- **Updating & uninstalling section** in `README.md` plus a forward-
  link from Quick start. Documents the three independent removal steps
  (project state, user-level config, npm-global binary), the
  state-lives table, the daily update-notifier behaviour, and the
  `OPENSIP_NO_UPDATE` / `NO_UPDATE_NOTIFIER` opt-outs.

### Fixed

- **`~/.opensip-tools/` is now reserved for `config.yml` only.**
  `@opensip-tools/contracts/persistence/store` and
  `@opensip-tools/core/lib/logger` previously defaulted to writing
  sessions, reports, and logs under the home directory if no caller
  bootstrapped them — letting the user-level dir accumulate state that
  the documented architecture said only ever held config. The
  fallbacks are gone; persistence APIs throw if used before
  `configurePersistencePaths()` and `initLogFile(dir)` requires its
  `dir` argument at compile time. Any pre-existing
  `~/.opensip-tools/{sessions,reports,logs,fit}` dirs are legacy cruft
  and are swept up by `opensip-tools uninstall`.

- **Stale `--force` flag in the architecture docs.** The
  `docs/public/70-reference/01-cli-commands.md` uninstall
  section documented a `--force` option; the actual flag has always
  been `--yes` / `-y`. Section rewritten to match reality and document
  the new `--project` mode.

## [1.0.9] — 2026-05-16

### Fixed

- **Per-check recipe config now reaches the check.** The
  `getCheckConfig(slug)` plumbing in `@opensip-tools/fitness` stored
  the recipe-service-supplied config map on a module-local `let` —
  which meant the CLI's bundled `@opensip-tools/fitness` (running the
  recipe service) and the plugin pack's resolved
  `@opensip-tools/fitness` (running the check + calling
  `getCheckConfig`) saw separate module-scope state. The recipe's
  `additionalSyncFunctions` / `additionalSelfDocumentingSuffixes` /
  `additionalSafeTOCTOUPaths` allowlists were silently never reaching
  the checks that read them — detached-promises / throws-documentation
  / null-safety / toctou-race-condition warned on every project-
  declared safe call site despite the recipe authoring them.

  The fix hoists the slot onto a `Symbol.for('@opensip-tools/fitness/
  currentRecipeCheckConfig')` entry on `globalThis`, so every loaded
  copy reads + writes the same well-known slot regardless of which
  package instance imported the module. The single-session contract
  (recipe service throws SESSION_IN_PROGRESS for concurrent runs) is
  unchanged; only the storage location moves.

  Regression coverage added in
  `recipes/__tests__/check-config.test.ts` — simulates "two copies"
  by reading `globalThis[Symbol.for(...)]` after `set`, confirming
  the value lands at the shared slot.

## [1.0.8] — 2026-05-16

### Fixed

- **Directive parser now recognises Markdown (`<!--`) and shell/YAML
  (`#`) comment prefixes.** Pre-1.0.8 `extractCheckIdFromDirective` in
  `@opensip-tools/fitness` only matched `//` and `/*` openers, so
  `@fitness-ignore-file <slug>` / `@fitness-ignore-next-line <slug>`
  pragmas inside Markdown documents, HTML files, YAML configs, shell
  scripts, and Python were silently ignored — the file got scanned
  despite the author's intent. Authors hit this when trying to
  suppress `file-length-limit` on intentionally-long doc-set
  catalogues (DEC indices, metric taxonomies) where the only natural
  comment syntax is `<!-- ... -->`. The fix extends the comment-prefix
  table to include `<!--` (4 chars) and `#` (1 char) alongside the
  existing `//` and `/*`. Eight new regression tests in
  `directive-parsing.test.ts` cover the four supported prefixes plus
  the rejection of unsupported forms (`;`, plain text).

## [1.0.7] — 2026-05-16

### Fixed — false-positive triage

Four built-in checks were producing high-rate false positives against
real-world TypeScript codebases. Each fix tightens the heuristic
without losing real-bug coverage; regression tests pin the FP cases.

- **`sql-injection`** (`@opensip-tools/checks-typescript`)
  - `SQL_CLAUSE_PATTERN` was case-insensitive — `/\b(?:WHERE|AND|OR|
    SET|VALUES)\b/i` matched the English words "and"/"or"/"set"/"where"
    inside CLI help text (`cli.info('Usage: ...\n' + '...and continues
    here\n')`), producing one error per concatenated help-string. Now
    case-sensitive; real SQL conventionally uppercases these.
  - Arm-3 (right-side string + clause keyword) now requires the SAME
    `+` chain to contain a real SQL keyword (`SELECT|INSERT|UPDATE|
    DELETE|...`) somewhere. Closes the residual FP where uppercase
    "AND" appears in non-SQL text.
  - Both template-literal and concat arms now skip arguments to
    output methods (`cli.info`, `console.log`, `logger.warn`, …).
    These call sites carry user-facing text, never SQL.
  - Extracted `analyzeSqlInjection(content, filePath)` as a top-level
    function for direct test invocation; added 7-test FP regression
    suite in `__tests__/sql-injection.test.ts`.

- **`context-mutation-check`** (`@opensip-tools/checks-typescript`)
  - Flagged `ctx.X = value` mutations even when `ctx` was a locally-
    declared `const`/`let`/`var` (object-construction pattern), not
    a shared request context. Now scans the file for local
    declarations of `ctx`/`context` via `LOCAL_DECLARATION_PATTERNS`
    and skips mutations rooted at locally-declared names.
  - Extracted `analyzeContextMutation` for direct test invocation;
    added 4-test FP regression suite.

- **`no-hardcoded-secrets`** (`@opensip-tools/checks-universal`)
  - Matched secret patterns inside REGEX LITERALS (the file IS the
    redactor — `[/-----BEGIN PRIVATE KEY-----.../g, replacement]`)
    and inside REDACTION PLACEHOLDERS (`'-----BEGIN PRIVATE KEY-----
    ***-----END PRIVATE KEY-----'`). Now adds two filters:
    `isInsideRegexLiteral(line, pos)` and `lineHasRedactionPlaceholder
    (line)` — the latter scans the whole line for `***`, `[REDACTED]`,
    `<REDACTED>`, or `XXXX+` runs, since the project-defined patterns
    typically only match the header (e.g. `-----BEGIN PRIVATE KEY-----`)
    and the redacted value follows.
  - Extracted `analyzeHardcodedSecrets`; added 3-test FP regression
    suite.

- **`eslint-justifications`** (`@opensip-tools/checks-universal`)
  - Reported "Malformed ESLint suppression comment" for rationales
    between 401 and 500 characters. The disable-pattern regex
    accepted bodies up to 500 chars (matching `MAX_JUSTIFICATION_
    LENGTH`) but the rationale-extraction regex capped at 400 — so
    rationales in the 401–500 window matched the outer pattern but
    failed the inner parse, producing the wrong error message
    instead of the accurate "too long" one. Now both bounds are 500.

### Internal

- All 17 packages bumped 1.0.6 → 1.0.7; cross-package `workspace:*`
  deps resolved to `1.0.7` via `pnpm pack`.
- Regression-test count: 14 new tests across the four fixes (all
  passing); 79 / 83 / 110 totals across `checks-typescript` and
  `checks-universal`.

## [1.0.6] — 2026-05-16

### Fixed

- **Plugin discovery now honors `package.json#opensip-tools.configPath`.**
  `readProjectPluginsList` in `@opensip-tools/core` previously hardcoded
  `<projectDir>/opensip-tools.config.yml`, ignoring the package.json
  pointer that the targets loader (`resolveProjectConfigPath`) already
  honored. Projects whose config lived at a non-default path — e.g.,
  pointing at `opensip-tools/opensip-tools.config.yml` in a monorepo
  with a vendor-tooling subdir — had their `plugins.<domain>: [...]`
  declaration silently skipped. The plugins dir then fell through to
  the empty default, and the declared pack never registered (so no
  recipes, no checks beyond the built-ins).

  The fix routes `readProjectPluginsList` through
  `resolveProjectConfigPath` so the precedence is identical across
  the two loaders: `--config` → `package.json#opensip-tools.configPath`
  → `<projectDir>/opensip-tools.config.yml`. Coverage added to
  `discover.test.ts` for the pointer + default-fallback cases.

## [1.0.0] — 2026-05-15

First stable release. Everything below was developed and iterated
internally; nothing in the 1.x range was ever published. The 0.x
releases listed further down are the actual public history.

### Architecture

- **Tool-plugin platform.** `@opensip-tools/core` is a strict kernel
  (errors, logger, IDs, language adapters, plugin loader, Tool
  contract). Fitness and simulation are first-party tools that
  implement the Tool contract; the CLI is a generic dispatcher that
  walks `defaultToolRegistry` and asks each tool to mount its own
  Commander subcommands. Adding a new tool — `audit`, `lint`,
  whatever — requires zero CLI changes.
- **Auto-discovery for tool packages.** Any npm package whose
  `package.json` declares `opensipTools.kind === 'tool'` is loaded
  by the CLI on startup; the walker matches Node's nearest-ancestor
  resolution.
- **Layered architecture enforced by dependency-cruiser.** core →
  contracts → fitness / simulation / lang-* (peers) → checks-* → cli.
  Forbidden edges fail CI.

### Packages (17)

- **`@opensip-tools/cli`** — generic tool dispatcher (Ink/React UI).
- **`@opensip-tools/core`** — kernel: errors, logger, IDs, language
  adapters, plugin loader, Tool contract, path resolution.
- **`@opensip-tools/contracts`** — CLI types, exit codes, session
  persistence, dashboard HTML generator.
- **`@opensip-tools/fitness`** — fitness engine + commands
  (`fit`, `dashboard`, `fit-list`, `fit-recipes`), recipe service,
  architecture gate (baseline/compare), SARIF reporting.
- **`@opensip-tools/simulation`** — simulation engine, sim recipes,
  built-in `default` recipe (selects all scenarios). Load + chaos
  scenario kinds are end-to-end functional; invariant and
  fix-evaluation are usable but their executors are MVP.
- **`@opensip-tools/checks-typescript`** (66 checks) — TS-AST checks
  (drizzle-orm, typed-inject, react, package.json#exports, tsconfig).
- **`@opensip-tools/checks-universal`** (88 checks) — text/regex/glob
  checks (Docker, .env, Sentry, generic structure).
- **`@opensip-tools/checks-{python,go,java,cpp}`** — language-specific
  packs (Python `no-bare-except`, Go `no-fmt-print`, Java
  `no-printstacktrace`, C/C++ `clang-tidy` passthrough).
- **`@opensip-tools/lang-{typescript,rust,python,go,java,cpp}`** —
  language adapters (typescript ships a tsc-based parser; the others
  are hand-written lexers, with tree-sitter integration deferred).

### CLI surface

```bash
opensip-tools                              # welcome screen
opensip-tools init                         # detect language + scaffold
opensip-tools fit --recipe example         # smoke test the example check
opensip-tools sim --recipe example         # smoke test the example scenario
opensip-tools fit                          # run the default recipe
opensip-tools fit --check <slug>           # run a single check
opensip-tools fit --tags <list>            # tag filter
opensip-tools fit --gate-save              # save baseline
opensip-tools fit --gate-compare           # diff against baseline
opensip-tools fit --report-to <url>        # SARIF upload to OpenSIP Cloud
opensip-tools dashboard                    # HTML report
opensip-tools fit-list / fit-recipes       # catalog browsing
opensip-tools sessions list|purge          # run history
opensip-tools plugin add|remove|list|sync  # project-local npm plugins
opensip-tools configure                    # cloud API key setup
opensip-tools completion                   # shell completion script
opensip-tools uninstall                    # remove ~/.opensip-tools/
```

### Project layout (v1)

User identity (cloud API key, theme) lives at `~/.opensip-tools/config.yml`.
Everything else is project-local:

```
<project>/
├── opensip-tools.config.yml                       (TRACKED)
├── opensip-tools/
│   ├── fit/{checks,recipes}/*.mjs                 (TRACKED — auto-loaded)
│   ├── sim/{scenarios,recipes}/*.mjs              (TRACKED — auto-loaded)
│   └── .runtime/                                  (GITIGNORED)
│       ├── sessions/         — run history
│       ├── reports/          — dashboard HTML
│       ├── logs/             — structured JSONL (rotated 7 days)
│       ├── cache/            — AST + prewarm caches
│       ├── plugins/<domain>/ — npm-installed plugin packages
│       └── baseline.sarif    — gate baseline
└── ...
```

### Plugin model

- **Source files (auto-loaded):** drop a `.mjs` into
  `opensip-tools/{fit,sim}/{checks,recipes,scenarios}/` and the loader
  picks it up. No config opt-in required.
- **npm packages (explicit):** `opensip-tools plugin add <pkg>`
  installs to `opensip-tools/.runtime/plugins/<domain>/node_modules/`
  and pins the name in `plugins.<domain>:` in
  `opensip-tools.config.yml`. Only packages explicitly listed there
  are loaded — transitive deps in the runtime tree do not auto-load.
- **`@opensip-tools/checks-*` packages** found in `node_modules/`
  (any ancestor) are auto-discovered as fitness check packs unless
  `plugins.autoDiscoverChecks: false` is set.

### `init` and onboarding

`opensip-tools init` detects the project's language(s) from filesystem
markers (`Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`,
`pom.xml`, `build.gradle`, `CMakeLists.txt`, `tsconfig.json`,
`package.json`) and scaffolds:

- `opensip-tools.config.yml` with one named target per detected language
- `opensip-tools/fit/checks/example-check.mjs` (one per language for
  polyglot projects, distinct slugs)
- `opensip-tools/fit/recipes/example-recipe.mjs`
- `opensip-tools/sim/scenarios/example-scenario.mjs`
- `opensip-tools/sim/recipes/example-recipe.mjs`
- `.gitignore` entry for `opensip-tools/.runtime/`

`--language <comma-separated>` overrides detection or specifies a
polyglot configuration explicitly. Ambiguous detection exits 2 with a
prompt — no partial scaffolding.

### Quality gates

- ESLint flat config (`typescript-eslint:recommendedTypeChecked` +
  sonarjs + unicorn + import) — workspace at 0 errors / 0 warnings.
- dependency-cruiser layer rules — 0 violations across 465 modules.
- knip — 0 unused exports / files.
- Vitest — 1308 tests passing across 17 packages.

### Migration from 0.x

1. Replace `@opensip-tools/checks-builtin` in your `package.json` with
   `@opensip-tools/checks-typescript` + `@opensip-tools/checks-universal`.
   The 158-check builtin pack is split: TS-AST checks moved into
   `checks-typescript`, text/regex/glob checks into `checks-universal`.
2. If you imported fitness symbols (`defineCheck`, `CheckViolation`,
   etc.) from `@opensip-tools/core`, switch the import to
   `@opensip-tools/fitness`. Core is a strict kernel now.
3. From your project root, run `opensip-tools init` to scaffold the
   v1 directory layout. Move any custom `.mjs` files from
   `~/.opensip-tools/fit/` into `<project>/opensip-tools/fit/checks/`
   (or `recipes/` if the file exports `recipes`). Move sim files the
   same way under `<project>/opensip-tools/sim/`.
4. If your config declared `plugins.checkPackages:` for npm-installed
   packs, run `opensip-tools plugin sync` to reinstall them under
   `<project>/opensip-tools/.runtime/plugins/`.
5. Replace any `opensip-tools plugin install` calls with
   `opensip-tools plugin add`. The `install` command was always doing
   two operations; `add` is the one-step equivalent.
6. Delete `~/.opensip-tools/{fit,sim,sessions,logs,reports}/` —
   they're no longer read. `opensip-tools uninstall` does this for you.

## [0.6.1] — 2026-05-07

### Fixed (`@opensip-tools/checks-builtin`)

- **`async-patterns` and `batch-operations`** — split the strip-comments
  preprocessing between per-match scanning and bounded-pattern
  detection. The 0.6.0 narrowings ran the full strip (including
  comments) for both, which caused new false positives on files where
  the bounded indicator was a comment (e.g.
  `assessment-runner/heartbeat-manager.ts`). Per-match scanning still
  strips comments to avoid JSDoc FPs; bounded-pattern detection now
  runs on original content to preserve operator hints.

## [0.6.0] — 2026-05-07

### Removed (`@opensip-tools/checks-builtin`) — BREAKING

Four checks have been removed from the default recipe because their
false-positive rate on idiomatic TypeScript codebases consistently
exceeded the bar for a built-in. Each was either opinion-based
("naming should be 3+ characters"), enforced an arbitrary numeric
cutoff ("functions should have ≤5 parameters"), or guarded a class of
bugs that doesn't meaningfully occur in practice ("exported objects
should be frozen"). Customers running `opensip-tools fit` against a
typical TypeScript repo would see a wall of false positives on day 1
— a poor first-impression experience that trains users to ignore
warnings rather than act on them.

- **`clean-code-naming-quality`** — flagged `EventEmitter.on`,
  `Drizzle.Tx`, `IO`, `OS`, `UI`, and any other short identifier as a
  violation of "min 3 characters". The allowlist needed to match the
  canonical short names of every TypeScript codebase. Naming is too
  team-specific to enforce by default.
- **`clean-code-function-parameters`** — flagged any function with >5
  parameters. Real APIs (DI constructors, Fastify handlers, LLM tool
  definitions) legitimately have wider signatures. The 5-param cutoff
  is a Robert C. Martin opinion, not a precision rule.
- **`mutable-exported-constants`** — defensive theater. Mutation of
  an exported object literal is rare in practice, and TypeScript's
  `Readonly<T>` + `as const` already provide compile-time protection
  for the real risk. The check fired on every codebase using
  `Object.freeze` (the canonical immutability primitive) until it
  was patched, then continued to flag legitimate frozen objects.
- **`god-function-detection`** — used arbitrary cyclomatic-complexity
  cutoffs (warning ≥18, error ≥20) that don't correlate with real
  bugs. Long functions are sometimes correct; complexity scores
  measure the wrong thing.

If a team wants any of these patterns enforced, they can re-add the
check as a workspace plugin under their own recipe — but they
shouldn't be defaults.

### Improved (`@opensip-tools/checks-builtin`) — Precision narrowings

A round of false-positive narrowings landed alongside the removals.
Every change shipped with at least one regression test asserting the
check does NOT fire on the previously-misidentified pattern.

- **`error-handling-quality`** — empty-catch detection iteratively
  strips leading single-line and block comments before testing for
  empty body. Previously, a catch with `// @fitness-ignore` followed
  by a real handler call was flagged as silently swallowing because
  the regex only checked the first character.
- **`api-contract-validation`** — skip "missing try-catch" warning
  for `handle*Error` and `process*Error` functions. These are
  themselves error translators called from inside a catch block;
  requiring another try-catch around them is error-handling
  inception.
- **`interface-implementation-consistency`** — skip "extra method"
  warning for classes named `Fake*`, `Mock*`, `Stub*`, `Spy*`. Test
  doubles intentionally extend the production interface with helper
  methods (`queueError`, `setEvents`, `reset`).
- **`async-patterns` (detached-promises)** — recognize `outer(await inner())`
  as a sync wrapper around an awaited promise. Previously flagged
  every `unwrap(await x)` pattern as detached.
- **`performance-anti-patterns`** — sequential-await detection skips
  retry/backoff loops where any of `await delay|sleep|wait|setTimeout|backoff|pause`
  appears in a 30-line forward window. Spread and string-concat
  detectors are unchanged.
- **`toctou-race-condition`** — full AST rewrite. Previously a
  regex-only check that paired any `.get(...)` with any `.set(...)`
  regardless of receiver. New detection classifies calls by receiver
  identity, recognizes local in-memory `Map`/`Set` collections,
  in-process cache fields (`this.cache`, `this.#cache`,
  `this.<X>Cache`), parameters typed `*Cache`, and atomic SQL
  writes (`tx.update`, `tx.execute(sql\`UPDATE ...\`)`).
- **`dead-code`** — Knip's per-issue path is now propagated to the
  violation record's `filePath`, so dead-dep warnings in a monorepo
  surface against the sub-package's `package.json` instead of
  collapsing onto root.
- **`duplicate-utility-functions`** — recognizes intentional
  variation (different generic constraints, side-effect profiles).
- **`test-file-naming`** — accepts `*-helper.ts` and `*-helpers.ts`
  suffix conventions alongside the canonical `*-test-setup.ts`.

### Migration

Customers on `0.5.x` who relied on any removed check should add the
check back as a workspace-local plugin or pin to `0.5.x`. No code
changes are required for the precision narrowings — they only
reduce noise.

## [0.5.0] — 2026-05-05

### Removed (`@opensip-tools/core`) — BREAKING

- The deprecated `contentFilter: 'code-only'` and
  `contentFilter: 'no-strings-no-comments'` aliases are removed.
  Migrate to the canonical names introduced in 0.4.0:
  - `'code-only'`              → `'strip-strings'`
  - `'no-strings-no-comments'` → `'strip-strings-and-comments'`
  Mapping is mechanical — same dispatch, same behaviour, just the
  spelling changes.

  Consumers of `@opensip-tools/core` who passed either old name to
  `defineCheck({ contentFilter, ... })` or to `createFileAccessor(...,
  { contentFilter })` will see a TypeScript narrowing error and a Zod
  validation rejection at runtime.

  Why now: `code-only` described intent, not behaviour, and the
  resulting confusion produced a real false-positive bug
  (`audit-sink-direct-use` firing on its own JSDoc) before the rename.
  Keeping the alias indefinitely would invite the same confusion to
  recur. The 0.4.0 release shipped both forms so consumers had a clean
  migration window; that window closes here.

## [0.4.0] — 2026-05-05

### Added (`@opensip-tools/core`)

- New `contentFilter` mode names that describe what the filter strips:
  - `'strip-strings'` — string literals blanked, comments preserved
    (use when a check reads comment-based directives like `// @swallow-ok`,
    `// @fitness-ignore-...`, or `@deprecated` JSDoc tags).
  - `'strip-strings-and-comments'` — both strings and comments blanked
    (use when a check pattern-matches identifiers that would false-fire
    if the same phrase appears in JSDoc / inline comments documenting
    the rule itself).

  The previous names (`'code-only'`, `'no-strings-no-comments'`)
  described intent rather than behaviour and were misleading enough to
  cause real false positives — `code-only` strips strings but PRESERVES
  comments, which most rule authors didn't expect from the name.

### Changed (`@opensip-tools/checks-builtin`)

- 82 built-in checks migrated to the new `strip-strings` /
  `strip-strings-and-comments` names.

### Deprecated (`@opensip-tools/core`)

- `contentFilter: 'code-only'` — use `'strip-strings'` instead (same
  dispatch, no behaviour change).
- `contentFilter: 'no-strings-no-comments'` — use
  `'strip-strings-and-comments'` instead (same dispatch).

  Both old names continue to work as aliases. Plan to remove in 0.5.0.

### Fixed (`@opensip-tools/checks-builtin`)

- `resilience/no-process-exit-in-finally` no longer false-fires on
  files that use `Promise.prototype.finally(...)` without a try/finally
  clause. The detection regex now requires `} finally {` brace
  adjacency rather than matching the bare word `finally`.
- `architecture/module-coupling-fan-out` no longer flags pure barrel
  files (only `export ... from` re-exports) or type-declaration files
  (`.d.ts`, `.test-d.ts`). Both are exempt by design — barrels fan out
  on purpose; type imports compile to nothing.

## [0.3.0] — earlier

(Release notes were not captured at the time. Includes various
infrastructure improvements over 0.2.5; see git log for details.)

## [0.2.5] — 2026-05-04

### Security

Users on 0.2.4 and earlier should upgrade. Three issues in plugin discovery
allowed code outside the plugin directory to be loaded and executed:

- **Path traversal in plugin discovery** (`@opensip-tools/core`). A malicious
  `.opensip-tools/fit/package.json` (or `~/.opensip-tools/fit/package.json`)
  with a dependency key like `"../../etc/passwd"` would resolve outside the
  plugins' `node_modules/` and the matching file could be dynamically
  imported. Now: dependency names containing `..`, leading `/`, or NUL bytes
  are rejected before any filesystem access, and resolved package paths are
  containment-checked against `node_modules/` via `realpathSync`.
- **Symlink follow in loose-file plugin discovery** (`@opensip-tools/core`).
  A symlink in `~/.opensip-tools/fit/` (or a project-local plugin dir)
  pointing to an arbitrary file outside the plugin dir would be loaded as a
  plugin and dynamically imported. Now: loose-file plugin paths are
  containment-checked against the plugin dir; pnpm-style symlinks that
  resolve inside the plugin dir continue to work.
- **Silent plugin load failure** (`@opensip-tools/cli`). When a plugin failed
  to import, errors were printed to stderr but the run still exited 0 with
  `passed: true` if no checks failed. A malicious or broken plugin could
  therefore suppress its own checks (including compliance-required checks)
  while CI reported success. Now: any plugin load error sets `passed: false`
  and produces a non-zero exit code.

### Tests

- Added 5 regression tests in `core/src/plugins/__tests__/discover.test.ts`
  covering `..` traversal, absolute-path names, NUL-byte names, escaping
  symlinks, and pnpm-legitimate symlinks.

## [0.3.0] — 2026-05-04

### Security

- **Plugin install no longer runs npm lifecycle scripts.** All three
  `npm install` invocations (project-local sync, user-level `plugin install`,
  and peer-dep auto-install) now pass `--ignore-scripts`. Without this,
  `opensip-tools fit` running in a freshly cloned repo with declared
  plugins would auto-install them and execute their `postinstall` /
  `preinstall` / `prepare` scripts before the user had any chance to
  inspect what was being installed. Plugins are loaded via dynamic
  `import()` at fit time, so legitimate plugin code paths are unaffected;
  only install-time side-effects are blocked.

### Performance

- **Shared AST parse cache for checks-builtin.** 10 AST-based checks
  (`circular-imports`, `deep-inheritance`, `export-complexity`,
  `fan-out-complexity`, `import-graph`, `interface-bloat`, `logger-detector`,
  `method-complexity`, `missing-error-handling`, `type-assertion-overuse`)
  now call `getSharedSourceFile()` instead of `ts.createSourceFile()`.
  Files parsed by multiple checks in the same run are parsed once and
  reused from an LRU cache, reducing CPU and memory overhead proportional
  to the number of co-running AST checks.

### Fixed

- **`withRetry` tolerates NaN / non-finite `maxAttempts`.** Passing
  `maxAttempts: NaN` (or `Infinity`, `-1`) previously caused an infinite
  retry loop. Now clamped to `max(1, floor(n))` with a `Number.isFinite`
  guard; non-finite inputs default to a single attempt.
- **ULID `extractTimestamp` handles multi-underscore ID prefixes.** The
  old implementation split on the first `_`, so IDs like
  `fitness_check_01JPHK...` returned a garbage substring. Now uses
  `id.slice(-26)` to always extract the last 26 characters (the canonical
  ULID component), regardless of prefix length or underscore count.
- **`filterCache` idle timer bounds memory growth.** The content-filter
  cache had no eviction path: after a large scan the filtered-content map
  would stay in memory for the process lifetime. A 10-minute idle timer
  (matching the parse-cache pattern) now clears the map when no new files
  are being scanned, returning memory between runs without affecting
  correctness.

### Observability

- Structured log events for all fitness check lifecycle stages now carry a
  `module: 'fitness:execution'` field, making it straightforward to filter
  check-level traces in log aggregators.
- All CLI-level logger calls in `cli:fit`, `cli:gate`, `cli:report`,
  `cli:persistence`, and `cli:bootstrap` now include a `module:` field,
  enabling per-component log filtering.
- `cli.plugin.autosync.start` and `cli.plugin.autosync.failed` events
  are now emitted when the CLI transparently installs project-local
  plugins, surfacing install activity and per-domain failures in
  structured logs.


### Added
- Ink-based CLI rendering with themed components (React for terminals)
- Commander.js for argument parsing with auto-generated `--help`
- `opensip-tools dashboard` — top-level HTML report command
- `opensip-tools sessions list` — view run history
- `opensip-tools sessions purge` — delete session data with confirmation
- `--verbose` flag shows detailed results table (default is compact summary)
- `--findings` flag shows per-check violation details
- `--debug` flag outputs structured JSON logs to stderr
- `--report-to` sends findings as SARIF 2.1.0 with retry on failure
- `failOnErrors` / `failOnWarnings` config for CI exit code control
- Structured JSON logging with ULID run IDs to `~/.opensip-tools/logs/`
- Theme system with terminal capability detection (NO_COLOR, tmux, truecolor)
- Shared animation clock for spinner
- `RunHeader` component showing tool info between banner and content
- Custom check plugin support via `~/.opensip-tools/fit/`
- `itemType` support in `defineCheck()` for accurate validated column display
- `withRetry()` utility for network calls with exponential backoff
- Result pattern (`ok()`, `err()`, `tryCatchAsync()`) in core
- `NetworkError`, `ConfigurationError` typed error classes
- ULID-based ID generation (`generatePrefixedId()`, `extractTimestamp()`)

### Changed
- CLI output layer migrated from raw console.log to Ink components
- Default `fit` output is now a single summary line (was full table)
- Score and PASS/FAIL removed from summary — data speaks for itself
- `Ignored` renamed to `Ignores` in table and summary
- `Validated` column shows human-readable format (`450 files`, `13 packages`, `—`)
- Replaced `successThreshold` with `failOnErrors`/`failOnWarnings`
- 3rd party tool checks auto-detect package manager (pnpm > yarn > npm)
- Knip dead-code check uses default config discovery (no hardcoded path)
- Missing tool detection: shows "{tool} is not installed" instead of cryptic errors

### Removed
- `opensip-tools asm` command and `@opensip-tools/assess` package
- 28 OpenSIP-specific fitness checks (moved to community plugin)
- 6 OpenSIP-specific tool checks (hardcoded paths)
- 3 OpenSIP-specific assessments
- `fit --dashboard` (replaced by top-level `dashboard` command)
- `fit --history` (replaced by `sessions list`)
- Score-based pass/fail from summary display
