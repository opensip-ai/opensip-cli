---
status: current
last_verified: 2026-06-12
release: v0.1.3
title: "FAQ"
audience: [getting-started]
purpose: "Common questions about adoption, edge cases, and what opensip-cli does or doesn't do."
source-files:
  - README.md
  - packages/cli/src/index.ts
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./03-vs-other-tools.md
---
# FAQ

Common questions. If yours isn't here, the answer probably lives somewhere in the [architecture corpus](../README.md) — or open an issue on [GitHub](https://github.com/opensip-ai/opensip-cli/issues).

---

### Is opensip-cli a linter replacement?

**No.** ESLint, Ruff, golangci-lint, and clang-tidy still belong in your toolchain — they're sharper at language-specific syntactic patterns. opensip-cli sits *above* linters: it adds the architectural rules, cross-file constraints, and polyglot gates that linters can't express. You run both in CI.

See [vs. other tools](./03-vs-other-tools.md) for the full comparison.

---

### Do I have to write recipes?

**No.** The built-in `default` recipe runs every enabled check. Recipes are useful when you want a named lineup ("`quick-smoke` for pre-commit, `full` for nightly") but they're optional. The quick start uses the scaffolded `example` recipe just to prove the wiring works.

---

### Do I have to use all three tools (fit, sim, graph)?

**No.** Each is independent. Most teams adopt `fit` first (the primary loop), add `graph` when they want static call-graph analysis, and only use `sim` if they have a workload to simulate. You can run `opensip fit` and never touch the others.

---

### Does it work offline?

**Yes.** The CLI runs fully offline. The optional `--report-to <url>` flag posts results to OpenSIP Cloud for trend dashboards, but it's opt-in — the tool works without it.

---

### What's OpenSIP Cloud, and do I need it?

OpenSIP Cloud is a separate product (at [opensip.ai](https://opensip.ai)) that aggregates results across runs and shows trend dashboards. **OpenSIP CLI is fully usable without it.** If you set an API key via `opensip configure` and use `--report-to`, runs get posted. Otherwise, the CLI runs entirely locally.

---

### Can I write checks in TypeScript instead of `.mjs`?

**Yes.** When a check pack outgrows a handful of `.mjs` files, you can promote `opensip-cli/fit/` to a workspace npm package: add a `package.json` declaring `opensipTools.kind: "fit-pack"`, switch the files to TypeScript, add `opensip-cli/*` to your workspace globs, run `pnpm i`. Marker-based discovery picks it up on the next run.

The graduation path is documented in [plugin authoring](../50-extend/01-plugin-authoring.md). The `.mjs` shape is faster for first-touch; the workspace-package shape is better once coverage grows.

---

### How do I adopt opensip-cli incrementally on a large codebase?

Use the **baseline gate flow.** Run `opensip fit --gate-save` once to capture every current violation as a baseline. Future CI runs use `--gate-compare` and fail only on *new* violations, not on the historical ones. You can fix the baseline over time without blocking PRs from day one.

`graph` has the same flow (`--gate-save` / `--gate-compare`) for catalog drift.

---

### What languages does it support?

`fit` runs against TypeScript / JavaScript, Python, Rust, Go, Java, and C/C++. Language detection is automatic (looks for `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`). Most built-in checks are language-agnostic (the 108-check `checks-universal` pack); the rest target a specific language pack.

`graph` ships five language adapters: TypeScript, Python, Rust, Go, Java. The TypeScript adapter uses the TypeScript compiler API; the Python, Go, Rust, and Java adapters parse with vendored web-tree-sitter WASM grammars, so there's no native toolchain or compiler to install for them.

`sim` is language-independent — scenarios are JavaScript and drive your service over HTTP.

---

### Can I run only one check?

**Yes.** `opensip fit --check <slug>` runs exactly one check. Useful for debugging a single rule or for pre-commit hooks that want one fast check.

---

### How fast is it?

Typical: a few seconds for a small project, sub-30-seconds for a large one. `graph` has incremental rebuild (edits to one file rebuild in ~2.5s vs ~15s cold on the opensip-cli self-graph).

The runtime cost scales with `checks × matched-files`, not with project size. A check with `scope: { languages: ['typescript'] }` only runs against TypeScript files, even in a polyglot repo. The execution model is parallel by default.

---

### What's the difference between a check, a recipe, a scenario, and a rule?

- **Check** — a single `fit` rule. One file, one `defineCheck()` call. Runs once per matched file.
- **Recipe** — a named lineup of checks (or scenarios) plus execution options. Used for "what should we run in this CI step?"
- **Scenario** — a single `sim` workload (load, chaos).
- **Rule** — what `graph` calls its analyses (orphan-subtree,
  duplicated-function-body, large-function, etc.). A rule is authored with
  `defineRule`, the call-graph parallel to `defineCheck`; ten ship in the box.
  The difference from a check is the input: a rule queries the engine
  **dataset** (call graph + derived feature columns), not a single file's
  `(content, filePath)`.

See [vocabulary](./05-vocabulary.md) for the full glossary.

---

### Is this an AI tool?

**No.** No model calls, no embeddings, no agentic anything. Plain TypeScript CLI. You can build an AI tool *on top of* the Tool plugin contract — that's exactly what the contract is for, and the contract is documented in [plugin authoring](../50-extend/01-plugin-authoring.md).

---

### How do I report a bug or request a feature?

[GitHub issues](https://github.com/opensip-ai/opensip-cli/issues). Bug reports should include `opensip --version`, a minimal reproduction, and the run's `opensip-cli/.runtime/logs/<date>.jsonl` file if relevant.

---

## What's next

| If you want to … | Go to … |
|---|---|
| See how opensip-cli compares to alternatives | [vs. other tools](./03-vs-other-tools.md) |
| See concrete code samples | [Show me each loop](./02-show-me-the-loops.md) |
| Run the first smoke test | [Quick start](./00-quick-start.md) |
| Browse all built-in checks | [Checks reference](../70-reference/05-checks-index.md) |
