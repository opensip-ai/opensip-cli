---
status: current
last_verified: 2026-05-22
release: v1.3.x
title: "What is opensip-tools"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The product entry point — what problem opensip-tools solves, what it actually does, the philosophy, and what it deliberately is not."
source-files:
  - README.md
  - packages/cli/src/index.ts
  - packages/core/src/tools/types.ts
  - packages/fitness/engine/src/tool.ts
  - packages/simulation/engine/src/tool.ts
related-docs:
  - ./02-vocabulary.md
  - ./03-system-context.md
  - ../10-mental-model/01-fitness-loop.md
  - ../10-mental-model/02-tool-plugin-model.md
---
# What is opensip-tools

You're joining the project, or you're about to depend on it. Before any package layout, any CLI flag, any plugin contract — start here. Read this doc, then [`02-vocabulary.md`](/docs/opensip-tools/00-orientation/02-vocabulary/), then [`03-system-context.md`](/docs/opensip-tools/00-orientation/03-system-context/). After those three, the rest of the doc set is just depth on parts you already understand at a sketch level.

> **What you'll understand after this:**
> - The problem opensip-tools solves and why it deserves a tool, not a script.
> - The three loops it runs today: `fit`, `sim`, and `graph`.
> - The philosophy — what "tool platform" means, why the CLI doesn't know what `fit` does.
> - Who opensip-tools is for, and what it deliberately is not.
> - Where to go next.

---

## The problem

Every codebase wants a quality bar. The bar is rarely controversial — `no console.log in production`, `circular imports forbidden`, `cyclomatic complexity capped at 25`, `cross-layer imports forbidden by the modular monolith`. What's controversial is enforcement: every team ends up writing a different bag of bash scripts, ad-hoc Node programs, and `awk`-pipelines stitched into CI to enforce its own bar. They drift. They aren't shareable. They're invisible to the IDE. They die when the engineer who wrote them changes teams.

The conventional answer is a giant linter — ESLint, Pylint, golangci-lint. Linters are great at small syntactic patterns. They're a poor fit for *architectural* checks: "no module under `packages/cli/` may import from `packages/fitness/checks-*`", "every `defineCheck` must declare at least one tag", "the file `apps/dashboard/src/main.tsx` must exist". They're also language-locked: a polyglot repo wants the same gate model in TypeScript and Python and Go.

opensip-tools is the alternative: **a polyglot, plugin-driven check runner** that takes a quality bar and turns it into a deterministic exit code. The runner doesn't know what your checks check; it knows how to discover them, run them, score them, render them, and gate on them.

---

## What it actually does

opensip-tools ships three first-party tools today, all invoked through the same CLI binary.

### `fit` — fitness checks

The primary loop. One run of `opensip-tools fit` does this:

1. **Resolve config.** Read `opensip-tools.config.yml` from the project root. Detect the project's languages from filesystem markers (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`).
2. **Load checks.** Walk `opensip-tools/fit/checks/*.mjs` for project-local checks. Walk `node_modules` for any package whose name matches `@opensip-tools/checks-*` (or any package listed in `plugins.checkPackages:`). Register each check it finds.
3. **Pick a recipe.** A recipe is a named selection of checks plus execution options. The default recipe runs every enabled check; named recipes (`--recipe quick-smoke`) narrow that.
4. **Run the recipe.** Execute checks in parallel by default (configurable per recipe). Each check returns a list of `Signal` objects — one per violation.
5. **Render and exit.** Print a results table (or JSON, or SARIF). Exit 0 if every check passed, 1 if any check failed, 2 for unrecoverable errors.

The whole loop is described in detail in [`../10-mental-model/01-fitness-loop.md`](/docs/opensip-tools/10-mental-model/01-fitness-loop/), which is the spine of this doc set.

### `sim` — simulation scenarios *(experimental)*

The second loop, opt-in. A scenario is a Node `.mjs` module that simulates a workload — load, chaos, invariant, fix-evaluation — and asserts something about the system under test. Recipes compose scenarios the same way fit recipes compose checks. The execution model is parallel by default; the output shape mirrors `fit`'s.

`sim` is younger than `fit` and changes more aggressively. The architecture-level shape is the same (Tool, Recipe, Engine, Renderer); the API surface still moves between minor releases.

### `graph` — static call-graph + dead-end analysis

The third loop. Where `fit` answers "is the codebase clean?" with a regex/AST pass over each file in isolation, `graph` answers "what is reachable from where?" by building the project's static call graph. The six-stage pipeline (discover → parse + walk → resolve → indexes → rules → render) ships with five rules — `orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch` — and is language-pluggable: TypeScript (symbol-resolved), Python (tree-sitter), and Rust (tree-sitter) adapters ship in v1.3.0.

`graph` has its own gate flow (`--gate-save` / `--gate-compare`) and renders into the dashboard's interactive Code Paths panel.

### Plus the surrounding plumbing

- `init` — scaffold `opensip-tools.config.yml` and example checks/scenarios.
- `dashboard` — open the local HTML report.
- `sessions` — list and prune past run records.
- `plugin add/remove/list/sync` — manage npm-installed plugins.
- `configure` — store an OpenSIP Cloud API key for centralized reporting.
- `completion` — print a shell completion script.
- `uninstall` — remove the user-level dotdir.

Every command lives in [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/cli/src/commands/).

---

## The big picture in three sentences

opensip-tools is a CLI dispatcher whose job is to find Tools (`fit`, `sim`, `graph`, anything you write), find recipes inside those Tools, run them, and render the result. Tools are decoupled from the CLI by a plugin contract; the CLI cannot tell `fit` from `sim` from `graph` from `audit-sec` you wrote yesterday — they all implement the same `Tool` interface, mount their own subcommands, and consume a shared rendering layer. The platform is intentionally narrow: no daemon, no server, no database, no orchestration — just a 18-package TypeScript monorepo that produces one binary and runs end-to-end in under a second on a small project.

---

## The philosophy

A few principles shape every design decision. They're load-bearing — most of the architecture only makes sense in their light.

### A platform, not a linter

opensip-tools is a platform with three tools shipped today (`fit`, `sim`, `graph`), designed for a fourth you haven't installed yet. The CLI ([`packages/cli/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/cli/src/index.ts)) is a generic dispatcher: it walks `defaultToolRegistry`, calls `Tool.register(cli)` on each entry, and lets each tool wire its own Commander commands. Adding a new tool is a plugin operation — install a package whose `package.json` declares `opensipTools.kind === 'tool'`, and the CLI picks it up.

This is not a hypothetical: it's why `fit`, `sim`, and `graph` ship in separate packages, depend on the same kernel ([`@opensip-tools/core`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/core/)), and have completely separate command surfaces. If `fit` ever wanted to know what `sim` was doing, it'd have to import it — which the layer policy forbids. They communicate through the CLI's render layer, not directly.

### Layered, not modular

The 19 packages are organized as a strict dependency layer cake: `core` at the bottom, `contracts` above it, then `fitness/simulation/graph/dashboard/lang-*` as peers, then `checks-*` packs (which depend on the language packs), then `cli` at the top. The layer policy is enforced by [dependency-cruiser](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/.dependency-cruiser.cjs) at lint time — the build fails if a `core` module imports from `fitness`, or if `lang-typescript` imports from `cli`.

This shape is what makes the tool-plugin model possible: the kernel doesn't know what tools exist (`core` defines `Tool` and `ToolRegistry` but never imports a Tool implementation), and tools don't know what other tools exist. New tools slot in *between* layers without touching anyone else.

See [`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/) for the full layer map.

### Polyglot via adapters

opensip-tools runs on TypeScript, but the checks it runs apply to TypeScript, Rust, Python, Java, Go, and C/C++ code. The trick is the `LanguageAdapter` interface ([`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/core/src/languages/adapter.ts)): each language pack contributes one adapter that knows how to strip comments and string literals from that language's source. Checks operate on the *filtered* content, so a regex like `/console\.log/` doesn't match the literal string `"console.log"` inside a JS comment.

The kernel ships zero adapters. The CLI binds the six bundled adapters at startup ([`packages/cli/src/index.ts:68-73`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/cli/src/index.ts)). A polyglot project gets every relevant pack; a single-language project still loads them all (cheap) and only invokes the relevant ones (per-file dispatch).

### The CLI is the only consumer

The kernel exports types, errors, IDs, the logger, the path resolver, and the registries. It does not export anything that knows about Commander, Ink, the dashboard browser-launcher, or the user's TTY. Those are CLI concerns, and they live in [`packages/cli/`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/cli/) — a single package that takes the dependency on every visual concern.

This means tests can run the kernel headlessly. It means a future GUI front-end could share everything below `packages/cli/`. It means the JSON output (which is structured by `contracts`) is portable: any consumer that can parse a `CliOutput` can integrate, without depending on the CLI itself.

### Determinism over flexibility

A check must produce the same result for the same input, full stop. There is no per-run network call inside a check (a check that requires a network call lives outside opensip-tools and feeds *signals* in via JSON). There is no time-of-day-dependent behavior. There is no shared mutable state between checks — each check gets its own `ExecutionContext` ([`packages/fitness/engine/src/framework/execution-context.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/packages/fitness/engine/src/framework/execution-context.ts)).

Determinism is what makes the `--gate-compare` flow possible: save a baseline today, compare next week, and the only differences are real changes in the codebase. See [`../60-subsystems/03-architecture-gate.md`](/docs/opensip-tools/60-subsystems/03-architecture-gate/).

---

## Who it's for

- **Polyglot teams** with a quality bar bigger than what one linter can express.
- **Architects** who want to encode "no cross-layer imports", "no circular deps", "the dashboard route file must exist", "every package must have a README" — and have CI fail when those rules drift.
- **Plugin authors** who want a kernel they can extend without forking. The Tool contract is the seam.
- **CI integrators** who want a deterministic exit code, a SARIF baseline, and a JSON output that doesn't change shape between minor releases.

The target user is a senior engineer or staff engineer who configures the bar (`opensip-tools.config.yml`), writes a handful of project-specific checks (`opensip-tools/fit/checks/*.mjs`), and trusts CI to run them on every PR.

---

## What it's not

A few common confusions, listed once so you can disambiguate.

- **opensip-tools is not a linter replacement.** ESLint, Ruff, and golangci-lint are still the right call for syntactic patterns inside one language. opensip-tools sits *above* linters: it ingests their output as signals, and it adds the architectural and cross-language checks linters can't express.
- **opensip-tools is not a service.** There's no daemon, no API server, no database. It's a CLI binary that exits when its work is done. (The optional Code Paths panel inside the dashboard is a static HTML view rendered from `graph`'s catalog, not a service.) The optional [OpenSIP Cloud](https://opensip.ai) integration is a separate product — opensip-tools posts results there if you set an API key, but the cloud is not required and is not in this repo.
- **opensip-tools is not opinionated about your bar.** It ships some default check packs (universal ones, plus per-language packs), but they're plugins. You can disable every default check and run only your own. The kernel has zero opinions about what `quality` means.
- **opensip-tools is not an AI tool.** No model calls, no embeddings, no agentic anything. It's a plain old TypeScript CLI. (You can build an AI tool *on top of* the Tool plugin contract — that's exactly what the contract is for.)
- **opensip-tools is not a CI runner.** It runs *under* CI. It doesn't replace GitHub Actions, GitLab CI, or Buildkite — it produces an exit code and a SARIF document those runners consume.

---

## What's next

You now have the product-level sketch. The next two orientation docs sharpen it:

- **[`02-vocabulary.md`](/docs/opensip-tools/00-orientation/02-vocabulary/)** — the words used everywhere in this codebase. *Tool, recipe, check, scenario, signaler, target, language adapter, plugin, session.* Reading this is the highest-leverage 15 minutes you'll spend on onboarding — most other docs assume you know the vocabulary.
- **[`03-system-context.md`](/docs/opensip-tools/00-orientation/03-system-context/)** — the box diagram. Where the binary lives, what it touches on disk, the user-level vs. project-level split.

After orientation, you want the mental-model section ([`../10-mental-model/`](/docs/opensip-tools/10-mental-model/)). Start with [`01-fitness-loop.md`](/docs/opensip-tools/10-mental-model/01-fitness-loop/) — it's the spine of the doc set and threads a single check end-to-end through the whole system.
