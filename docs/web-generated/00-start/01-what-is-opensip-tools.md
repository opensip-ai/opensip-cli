---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "What is opensip-tools?"
audience: [getting-started, contributors]
purpose: "The front door — what problem opensip-tools solves, what it does, what it isn't, and how to try it."
source-files:
  - README.md
  - packages/cli/src/index.ts
  - packages/cli/src/ui/components/Summary.tsx
  - packages/core/src/tools/types.ts
related-docs:
  - ./00-quick-start.md
  - ./02-show-me-the-loops.md
  - ./05-vocabulary.md
  - ./06-system-context.md
  - ./07-architecture-overview.md
  - ../10-concepts/01-fitness-loop.md
  - ../10-concepts/02-tool-plugin-model.md
---
# What is opensip-tools?

**opensip-tools enforces a quality bar that linters can't.**

You write the rules. The runner discovers them, runs them across TypeScript / Python / Rust / Go / Java / C/C++ (all in one pass), reports the result, and exits non-zero in CI when the bar is broken.

```text
> opensip-tools fit
  Fitness Checks
  Recipe: default   Checks: 167   Project: ~/work/my-app

  Scanning your codebase for quality, security, and architecture issues.
  ────────────────────────────────────────────────────────────

  ✓ no-console-log              312 files,   0 violations
  ✓ no-circular-imports         312 files,   0 violations
  ✗ no-cross-layer-imports      312 files,   4 violations
  ✓ no-eval                     312 files,   0 violations
  ✓ no-hardcoded-secrets        312 files,   0 violations
  ...

  166 Passed, 1 Failed (4 Errors, 0 Warnings) | Duration 8.1s
```

Exit code is `0` when nothing broke the bar, non-zero when something did. That's all CI needs.

---

## What it does well

- **Architectural rules.** "No module under `packages/cli/` may import from `packages/fitness/checks-*`." Linters can't say this; opensip-tools can, in 15 lines.
- **Cross-language gates in one runner.** A polyglot repo gets one CI step, not six. ~165+ checks ship in the box across seven packs; most are language-agnostic, and the rest target a specific language.
- **CI surfacing.** Outputs SARIF for GitHub PR annotations. Baselines for "fail only on *new* violations" so you can adopt incrementally without rewriting the codebase first.

## What it deliberately isn't

- **Not a linter replacement.** ESLint, Ruff, and golangci-lint are still the right call for syntactic patterns inside one language. opensip-tools sits *above* linters: it adds architectural and cross-language checks linters can't express.
- **Not a bundled-rules product.** Useful checks ship with it, but the point is *you write your own* for the constraints that matter to your codebase. The built-ins are a starting point, not the product.
- **Not a SaaS.** The binary runs locally and in your CI. There's an optional cloud reporting endpoint (`--report-to`), but it's opt-in; the tool works fully offline.

---

## The problem it solves

Every codebase wants a quality bar. The bar is rarely controversial — `no console.log in production`, `circular imports forbidden`, `cyclomatic complexity capped at 25`, `cross-layer imports forbidden by the modular monolith`. What's controversial is **enforcement**: every team ends up writing a different bag of bash scripts, ad-hoc Node programs, and `awk`-pipelines stitched into CI to enforce its own bar. They drift. They aren't shareable. They're invisible to the IDE. They die when the engineer who wrote them changes teams.

The conventional answer is a giant linter. Linters are great at small syntactic patterns, but a poor fit for *architectural* checks like "no module under `packages/cli/` may import from `packages/fitness/checks-*`" or "every `defineCheck` must declare at least one tag". They're also language-locked: a polyglot repo wants the same gate model in TypeScript and Python and Go.

opensip-tools is the alternative: **a polyglot, plugin-driven check runner** that takes a quality bar and turns it into a deterministic exit code. The runner doesn't know what your checks check; it knows how to discover them, run them, score them, render them, and gate on them.

---

## The three loops

opensip-tools ships three first-party tools, all invoked through the same CLI binary. Each answers a different question shape:

### `fit` — fitness checks

The primary loop. *"Is the codebase clean?"* A check runs once per file and returns violations. Checks compose into recipes; recipes drive CI. Project-local checks live as `.mjs` files under `opensip-tools/fit/checks/`; published packs live as npm packages. The whole loop is described in detail in [`../10-concepts/01-fitness-loop.md`](/docs/opensip-tools/10-concepts/01-fitness-loop/), the spine of this doc set.

### `sim` — simulation scenarios *(experimental)*

The second loop, opt-in. *"Does it behave correctly under stress?"* A scenario simulates a workload — load, chaos — and asserts something about the system under test. Same Tool/Recipe/Engine/Renderer shape as `fit`; the API surface still moves between minor releases.

### `graph` — static call-graph analysis

The third loop. *"What is reachable from where?"* Builds the project's static call graph in a staged pipeline and runs built-in rules over it. As of v2.6.0 the graph tool is a *peer* of `fit`: rules are authored with `defineRule` (mirroring `defineCheck`), selected through the same shared recipe substrate, and their findings land in sessions and the dashboard just like fitness checks. Ten rules ship today — the original five reachability/duplication rules (`orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`) plus five structural rules (`large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`). Per-function metrics — size, fan-out, blast radius, test coverage — are computed by an engine feature layer and surfaced both as rule findings and in the dashboard's graph view. Five language adapters ship (TypeScript, Python, Rust, Go, Java). Has its own baseline-gate flow.

The CLI doesn't know what any of these three do internally — they're tools registered against a shared dispatcher. Same model lets a future `audit` or `lint` tool slot in without CLI changes. For the architecture behind that decoupling, see [`../10-concepts/02-tool-plugin-model.md`](/docs/opensip-tools/10-concepts/02-tool-plugin-model/).

---

## Time to first signal: ~3 minutes

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
cd your-project
opensip-tools init
opensip-tools fit --recipe example
```

`init` detects your project's language(s) and scaffolds an example check and config. `fit --recipe example` runs that one check to prove the wiring works. From there, edit the example or delete it and write your own.

---

## Where to go next

| If you want to … | Go to … |
|---|---|
| See what real fit / sim / graph code looks like | [Show me each loop](/docs/opensip-tools/00-start/02-show-me-the-loops/) |
| Run the four-command smoke right now | [Quick start](/docs/opensip-tools/00-start/00-quick-start/) |
| Learn the vocabulary used across the docs | [Vocabulary](/docs/opensip-tools/00-start/05-vocabulary/) |
| Understand the runtime layout (what's on disk) | [System context](/docs/opensip-tools/00-start/06-system-context/) |
| See the high-level architecture map | [Architecture overview](/docs/opensip-tools/00-start/07-architecture-overview/) |
| Go deeper on the architecture (contributors) | [Mental model](/docs/opensip-tools/10-concepts/) → [Architecture index](/docs/opensip-tools/) |
