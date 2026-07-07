---
status: current
last_verified: 2026-07-07
release: v0.5.0
title: "FAQ"
audience: [getting-started]
purpose: "Common questions about adoption, edge cases, and what opensip-cli does or doesn't do."
source-files:
  - README.md
  - packages/cli/src/index.ts
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./03-vs-other-tools.md
  - ../60-guides/use-opensip-with-ai-agents.md
  - ../../decisions/ADR-0095-ai-native-guardrail-platform-posture.md
---
# FAQ

Common questions. If yours isn't here, the answer probably lives somewhere in the [architecture corpus](/docs/opensip-cli/) — or open an issue on [GitHub](https://github.com/opensip-ai/opensip-cli/issues).

---

### Is the CLI localized / translated?

**No — English only today.** Programming-language adapters (`lang-typescript`,
`lang-rust`, …) are for parsing source code, not UI localization. Localization
extraction is deferred unless an enterprise contract requires it — see
[ADR-0072](https://github.com/opensip-ai/opensip-cli/blob/v0.5.0/docs/decisions/ADR-0072-i18n-posture.md).

---

### Does opensip-cli "phone home"?

**Not for telemetry.** Summary by surface ([ADR-0070](https://github.com/opensip-ai/opensip-cli/blob/v0.5.0/docs/decisions/ADR-0070-telemetry-and-outbound-network-posture.md)):

- **OpenTelemetry:** off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **OpenSIP Cloud sync:** off without an API key and entitlement; disable with
  `--no-cloud` or config.
- **Update notifications:** default-on for interactive TTY (hourly npm version
  check); silence with `OPENSIP_NO_UPDATE=1` or `NO_UPDATE_NOTIFIER=1`.
- **Supply-chain checks:** local inspection of lockfiles/workflows — no hidden
  telemetry.

Update state stores only `{ latest }` — no user paths or credentials.

---

### Is opensip-cli a linter replacement?

**No.** ESLint, Ruff, golangci-lint, and clang-tidy still belong in your toolchain — they're sharper at language-specific syntactic patterns. opensip-cli sits *above* linters: it adds the architectural rules, cross-file constraints, and polyglot gates that linters can't express. You run both in CI.

See [vs. other tools](/docs/opensip-cli/00-start/03-vs-other-tools/) for the full comparison.

---

### Do I have to write recipes?

**No.** The built-in `default` recipe runs every enabled check. Recipes are useful when you want a named lineup ("`quick-smoke` for pre-commit, `full` for nightly") but they're optional. The quick start uses the scaffolded `example` recipe just to prove the wiring works.

---

### Do I have to use every built-in tool?

**No.** Each is independent. Most teams adopt `fit` first (the primary loop), add
`graph` when they want static call-graph analysis, run `yagni` when they want an
advisory reduction audit, and only use `sim` if they have a workload to
simulate. You can run `opensip fit` and never touch the others.

---

### Does it work offline?

**Yes.** The CLI runs fully offline. Optional `--report-to <url>` delivery posts
SARIF to an explicitly configured endpoint, and optional OpenSIP Cloud signal
sync is disabled unless an API key and entitlement are configured. The local
report, sessions, JSON, gates, and installed adapter runs work without network
access.

---

### What's OpenSIP Cloud, and do I need it?

OpenSIP Cloud is a separate product (at [opensip.ai](https://opensip.ai)) that
aggregates CLI evidence across runs. **OpenSIP CLI is fully usable without it.**
There are two optional network paths:

- `--report-to <url>` explicitly POSTs SARIF to OpenSIP Cloud or another
  compatible receiver and can fail a CI build with exit code 4 when upload fails.
- Cloud signal sync sends native OpenSIP signals best-effort only when an API key
  and cloud entitlement are configured; disable it with `--no-cloud` or config.

---

### Can I write checks in TypeScript instead of `.mjs`?

**Yes.** When a check pack outgrows a handful of `.mjs` files, you can promote `opensip-cli/fit/` to a workspace npm package: add a `package.json` declaring `opensipTools.kind: "fit-pack"`, `targetDomain: "fit-pack"`, and `targetDomainApiVersion: 1`, switch the files to TypeScript, add `opensip-cli/*` to your workspace globs, run `pnpm i`. Marker-based discovery picks it up on the next run.

The graduation path is documented in [plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/). The `.mjs` shape is faster for first-touch; the workspace-package shape is better once coverage grows.

---

### How do I adopt opensip-cli incrementally on a large codebase?

Use the **baseline gate flow.** Run `opensip fit --gate-save` once to capture every current violation as a baseline. Future CI runs use `--gate-compare` and fail only on *new* violations, not on the historical ones. You can fix the baseline over time without blocking PRs from day one.

`graph` has the same flow (`--gate-save` / `--gate-compare`) for catalog drift.

---

### What languages does it support?

`fit` runs against TypeScript / JavaScript, Python, Rust, Go, Java, and C/C++. Language detection is automatic (looks for `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`). Most built-in checks are language-agnostic (the 96-check `checks-universal` pack); the rest target a specific language pack.

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
  duplicated-function-body, near-duplicate-function-body, large-function, etc.).
  A rule is authored with `defineRule`, the call-graph parallel to
  `defineCheck`; eleven ship in the box.
  The difference from a check is the input: a rule queries the engine
  **dataset** (call graph + derived feature columns), not a single file's
  `(content, filePath)`.

See [vocabulary](/docs/opensip-cli/00-start/05-vocabulary/) for the full glossary.

---

### Can I use security tools I already have, like Gitleaks?

**Yes.** Install the OpenSIP adapter, keep managing the scanner binary yourself,
and run `doctor` to confirm the binary and local prerequisites are ready:

```bash
opensip tools install @opensip-cli/tool-gitleaks
opensip gitleaks doctor
opensip gitleaks
```

The shipped opt-in adapters cover Gitleaks, Semgrep, ast-grep, Ruff,
golangci-lint, govulncheck, cargo-deny, Bandit, pip-audit, cargo-clippy,
SpotBugs, PMD, Dependency-Check, Cppcheck, OSV-Scanner, and Trivy. Adapter
findings become normal OpenSIP signals: they appear in sessions, JSON, SARIF,
the HTML report, live CLI progress, and the baseline ratchet. See
[External tool adapters](/docs/opensip-cli/50-extend/08-external-tool-adapters/).

---

### Is this an AI tool?

**Not in the model-runtime sense.** opensip-cli does not call models, create
embeddings, or autonomously change your code. It is a plain TypeScript CLI that
emits deterministic evidence.

It is intentionally **AI-agent friendly**: `--json`, sessions, `agent-catalog`,
MCP, agent filters, and agent recipes let external coding agents inspect prior
runs, understand blast radius, and verify their work. The product boundary is:
agents may consume OpenSIP's guardrails; OpenSIP itself is not the agent.

See [Use OpenSIP with AI agents](/docs/opensip-cli/60-guides/use-opensip-with-ai-agents/),
[Connect MCP clients](/docs/opensip-cli/60-guides/08-connect-mcp-clients/), and
[plugin authoring](/docs/opensip-cli/50-extend/01-plugin-authoring/).

---

### How do I report a bug or request a feature?

[GitHub issues](https://github.com/opensip-ai/opensip-cli/issues). Bug reports should include `opensip --version`, a minimal reproduction, and the run's `opensip-cli/.runtime/logs/<date>.jsonl` file if relevant.

---

## What's next

| If you want to … | Go to … |
|---|---|
| See how opensip-cli compares to alternatives | [vs. other tools](/docs/opensip-cli/00-start/03-vs-other-tools/) |
| See concrete code samples | [Show me each loop](/docs/opensip-cli/00-start/02-show-me-the-loops/) |
| Run the first smoke test | [Quick start](/docs/opensip-cli/00-start/00-quick-start/) |
| Browse all built-in checks | [Checks reference](/docs/opensip-cli/70-reference/05-checks-index/) |
