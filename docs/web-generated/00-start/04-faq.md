---
status: current
last_verified: 2026-06-03
release: v2.6.x
title: "FAQ"
audience: [getting-started]
purpose: "Common questions about adoption, edge cases, and what opensip-tools does or doesn't do."
source-files:
  - README.md
  - packages/cli/src/index.ts
related-docs:
  - ./01-what-is-opensip-tools.md
  - ./03-vs-other-tools.md
---
# FAQ

Common questions. If yours isn't here, the answer probably lives somewhere in the [architecture corpus](/docs/opensip-tools/) — or open an issue on [GitHub](https://github.com/opensip-ai/opensip-tools/issues).

---

### Is opensip-tools a linter replacement?

**No.** ESLint, Ruff, golangci-lint, and clang-tidy still belong in your toolchain — they're sharper at language-specific syntactic patterns. opensip-tools sits *above* linters: it adds the architectural rules, cross-file constraints, and polyglot gates that linters can't express. You run both in CI.

See [vs. other tools](/docs/opensip-tools/00-start/03-vs-other-tools/) for the full comparison.

---

### Do I have to write recipes?

**No.** The built-in `default` recipe runs every enabled check. Recipes are useful when you want a named lineup ("`quick-smoke` for pre-commit, `full` for nightly") but they're optional. The four-command quick-start uses the scaffolded `example` recipe just to prove the wiring works.

---

### Do I have to use all three tools (fit, sim, graph)?

**No.** Each is independent. Most teams adopt `fit` first (the primary loop), add `graph` when they want static call-graph analysis, and only use `sim` if they have a workload to simulate. You can run `opensip-tools fit` and never touch the others.

---

### Does it work offline?

**Yes.** The CLI runs fully offline. The optional `--report-to <url>` flag posts results to OpenSIP Cloud for trend dashboards, but it's opt-in — the tool works without it.

---

### What's OpenSIP Cloud, and do I need it?

OpenSIP Cloud is a separate product (at [opensip.ai](https://opensip.ai)) that aggregates results across runs and shows trend dashboards. **opensip-tools is fully usable without it.** If you set an API key via `opensip-tools configure` and use `--report-to`, runs get posted. Otherwise, the CLI runs entirely locally.

---

### Can I write checks in TypeScript instead of `.mjs`?

**Yes.** When a check pack outgrows a handful of `.mjs` files, you can promote `opensip-tools/fit/` to a workspace npm package: add a `package.json` declaring `opensipTools.kind: "fit-pack"`, switch the files to TypeScript, add `opensip-tools/*` to your workspace globs, run `pnpm install`. Marker-based discovery picks it up on the next run.

The graduation path is documented in [plugin authoring](/docs/opensip-tools/50-extend/01-plugin-authoring/). The `.mjs` shape is faster for first-touch; the workspace-package shape is better once coverage grows.

---

### How do I adopt opensip-tools incrementally on a large codebase?

Use the **baseline gate flow.** Run `opensip-tools fit --gate-save` once to capture every current violation as a baseline. Future CI runs use `--gate-compare` and fail only on *new* violations, not on the historical ones. You can fix the baseline over time without blocking PRs from day one.

`graph` has the same flow (`--gate-save` / `--gate-compare`) for catalog drift.

---

### What languages does it support?

`fit` runs against TypeScript / JavaScript, Python, Rust, Go, Java, and C/C++. Language detection is automatic (looks for `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`). 90 of the 145+ built-in checks are language-agnostic; the rest target a specific language pack.

`graph` ships five language adapters: TypeScript, Python, Rust, Go, Java. The TypeScript adapter uses the TypeScript compiler API; the Python, Go, Rust, and Java adapters parse with vendored web-tree-sitter WASM grammars, so there's no native toolchain or compiler to install for them.

`sim` is language-independent — scenarios are JavaScript and drive your service over HTTP.

---

### Can I run only one check?

**Yes.** `opensip-tools fit --check <slug>` runs exactly one check. Useful for debugging a single rule or for pre-commit hooks that want one fast check.

---

### How fast is it?

Typical: a few seconds for a small project, sub-30-seconds for a large one. `graph` has incremental rebuild (edits to one file rebuild in ~2.5s vs ~15s cold on the opensip-tools self-graph).

The runtime cost scales with `checks × matched-files`, not with project size. A check with `scope: { languages: ['typescript'] }` only runs against TypeScript files, even in a polyglot repo. The execution model is parallel by default.

---

### What's the difference between a check, a recipe, a scenario, and a rule?

- **Check** — a single `fit` rule. One file, one `defineCheck()` call. Runs once per matched file.
- **Recipe** — a named lineup of checks (or scenarios) plus execution options. Used for "what should we run in this CI step?"
- **Scenario** — a single `sim` workload (load, chaos, invariant, fix-evaluation).
- **Rule** — what `graph` calls its analyses (orphan-subtree, duplicated-function-body, large-function, etc.). As of v2.6.0 a rule is authored with `defineRule`, the call-graph parallel to `defineCheck`; ten ship in the box. The difference from a check is the input: a rule queries the engine **dataset** (call graph + derived feature columns), not a single file's `(content, filePath)`.

See [vocabulary](/docs/opensip-tools/00-start/05-vocabulary/) for the full glossary.

---

### Is this an AI tool?

**No.** No model calls, no embeddings, no agentic anything. Plain TypeScript CLI. You can build an AI tool *on top of* the Tool plugin contract — that's exactly what the contract is for, and the contract is documented in [plugin authoring](/docs/opensip-tools/50-extend/01-plugin-authoring/).

---

### What does v2.0 break from v1?

v2.0 swaps internal runtime persistence from JSON files to SQLite. **v2 ignores v1's `<project>/opensip-tools/.runtime/` contents** and initializes a fresh `datastore.sqlite` on first run. Caches rebuild automatically. The `--baseline <path>` flag is removed — there is now exactly one gate baseline per project, stored in the SQLite database. See the v2.0.0 entry in [CHANGELOG.md](https://github.com/opensip-ai/opensip-tools/blob/main/CHANGELOG.md) for details.

---

### How do I report a bug or request a feature?

[GitHub issues](https://github.com/opensip-ai/opensip-tools/issues). Bug reports should include `opensip-tools --version`, a minimal reproduction, and the run's `opensip-tools/.runtime/logs/<date>.jsonl` file if relevant.

---

## What's next

| If you want to … | Go to … |
|---|---|
| See how opensip-tools compares to alternatives | [vs. other tools](/docs/opensip-tools/00-start/03-vs-other-tools/) |
| See concrete code samples | [Show me each loop](/docs/opensip-tools/00-start/02-show-me-the-loops/) |
| Run the four-command smoke | [Quick start](/docs/opensip-tools/00-start/00-quick-start/) |
| Browse all 145+ built-in checks | [Checks reference](/docs/opensip-tools/70-reference/05-checks-index/) |
