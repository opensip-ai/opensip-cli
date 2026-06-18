---
status: current
last_verified: 2026-06-14
release: v0.1.6
title: "vs. other tools"
audience: [getting-started]
purpose: "Honest comparison: what opensip-cli does that ESLint, Semgrep, Sonarqube, and Snyk don't — and what it deliberately doesn't try to do."
source-files:
  - README.md
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./04-faq.md
---
# vs. other tools

OpenSIP CLI is not a replacement for ESLint, Semgrep, or Sonarqube — it complements them. This page lays out what's overlapping, what's distinct, and when each tool is the right call. No marketing — just the honest shape.

## At a glance

| | opensip-cli | ESLint / Ruff / golangci-lint | Semgrep | Sonarqube | Snyk |
|---|---|---|---|---|---|
| **Polyglot in one run** | ✓ TS, Python, Rust, Go, Java, C/C++ | ✗ (one per language) | ✓ | ✓ | ✓ (security focus) |
| **User-authored architectural rules** | ✓ (`defineCheck` in 15 lines) | partial (custom rules per linter) | ✓ (Semgrep YAML) | partial (XPath-ish) | ✗ |
| **Static call-graph rules** (orphan code, dead paths, structural) | ✓ (10 built-in, `defineRule`) | ✗ | partial | ✓ | ✗ |
| **Load / chaos simulation** | ✓ (`sim`) | ✗ | ✗ | ✗ | ✗ |
| **CI gate with baselines** | ✓ (`--gate-save` / `--gate-compare`) | partial (snapshot files) | ✓ | ✓ | ✓ |
| **SARIF output for PR annotations** | ✓ | partial | ✓ | ✓ | ✓ |
| **Runs offline (no SaaS required)** | ✓ | ✓ | ✓ | partial | ✗ |
| **Free / open source** | ✓ Apache-2.0 | ✓ | ✓ (OSS engine + paid cloud) | partial (Community Edition) | ✗ (commercial) |
| **Per-project plugins via `.mjs` files** | ✓ | partial | ✗ | ✗ | ✗ |
| **Marketplace of rules** | partial (npm packages) | ✓ (huge) | ✓ (large registry) | partial | partial |

---

## Should I use opensip-cli or X?

### vs. ESLint, Ruff, golangci-lint, clang-tidy

**Use linters for what they're good at:** language-specific syntactic patterns and stylistic preferences inside one file. `no-unused-vars`, `prefer-const`, formatting, AST-level idiom enforcement. These are exactly what linters were designed for.

**Use opensip-cli above them**, for things linters can't express:

- *Architectural rules* — "no module under `packages/cli/` may import from `packages/fitness/checks-*`". This is a project-shape rule, not a syntactic one.
- *Cross-file constraints* — "every package directory must have a README.md and a tsconfig.json".
- *Cross-language rules* — "no console.log in production code", but applied uniformly to TypeScript and Python and Rust.
- *Things that need to look at multiple files at once* — duplicated function bodies, orphan call-graph subtrees, drift from a stored baseline.

Linters and opensip-cli coexist. They answer different questions; you run both in CI.

### vs. Semgrep

This is the closest comparison — both are polyglot rule runners aimed above traditional linters. The differences:

- **Rule format.** Semgrep rules are YAML pattern-matching expressions. OpenSIP CLI checks are TypeScript/JS functions. Semgrep's YAML is more compact for syntactic patterns; opensip-cli's code is more flexible for arbitrary logic (multi-file analysis, custom data structures, fetching the package graph). If your rules are mostly "match this pattern with these variables", Semgrep is sharper. If your rules need to walk the call graph or check that a specific file exists, OpenSIP CLI is sharper.
- **Sim and graph loops.** opensip-cli also ships `sim` (load / chaos simulation) and `graph` (static call-graph rules, authored the same way `fit` checks are via `defineRule`). These don't have Semgrep equivalents. If you want one tool for "is the code clean" + "does it behave under load" + "what's reachable", opensip-cli covers all three.
- **Hosting.** Semgrep's OSS engine is free; their cloud product (App / Pro) is paid and where most of the rule library lives. OpenSIP CLI is fully open-source — no separate cloud product is required. The optional `--report-to` endpoint posts to OpenSIP Cloud for dashboards, but the CLI works fully offline.

Many teams use both: Semgrep for the security-rule library, opensip-cli for project-shape and architecture rules.

### vs. Sonarqube

Sonarqube is the closest in *scope* — multi-language code quality with rule customization and baseline tracking — but the operating model is different:

- **Sonarqube is a server.** You run an analyzer (sonar-scanner) that posts to a Sonarqube instance, and gates happen in the server. OpenSIP CLI is a CLI that exits with a code. No server, no database (beyond a local SQLite file for sessions).
- **Rules.** Sonarqube ships thousands of pre-built rules; customizing them requires the (paid) Developer Edition or higher. opensip-cli ships 151 checks across seven packs and assumes you'll author project-specific ones in 15-line files.
- **Architecture rules.** Sonarqube has limited architecture-rule support (some via XPath in Java). OpenSIP CLI is designed *around* architectural rules — that's the central use case.

If you want a managed server with a UI for triage, Sonarqube fits. If you want a CLI that exits with an exit code and lives entirely in your repo, OpenSIP CLI fits.

### vs. Snyk

Snyk is a security platform — vulnerability scanning, dependency CVE checks, secret detection, IaC misconfiguration. OpenSIP CLI is not in that category. The categories overlap only in the "fail CI on bad code" gate model; the content is completely different.

- Use Snyk for: CVE scanning, license compliance, container/IaC security.
- Use opensip-cli for: code quality, architectural rules, project shape, static analysis findings.

They coexist comfortably in the same CI pipeline.

---

## What opensip-cli deliberately isn't trying to be

A short anti-claims list, since "what we don't do" is often more useful than "what we do":

- **Not a linter replacement.** ESLint, Ruff, golangci-lint, and clang-tidy still belong in your toolchain.
- **Not a service.** No daemon. No API server. The optional OpenSIP Cloud dashboard is a separate product that opensip-cli can post to, not require.
- **Not opinionated about your bar.** The built-in checks (151 across seven packs) are a starting point. The point is *your* rules — the constraints that matter to your codebase.
- **Not a CI runner.** It runs *under* GitHub Actions / GitLab CI / Buildkite. Produces an exit code and SARIF; doesn't replace your CI orchestrator.
- **Not an AI tool.** No model calls, no embeddings, no agentic anything. (You can build an AI tool *on top of* the Tool plugin contract.)
- **Not a security scanner.** Limited security checks (no-eval, no-hardcoded-secrets, sql-injection patterns) ship in `checks-universal`, but Snyk / Dependabot / GitHub Advanced Security are the right call for CVE-scale work.

---

## What's next

| If you want to … | Go to … |
|---|---|
| See concrete code samples for each loop | [Show me each loop](./02-show-me-the-loops.md) |
| Common questions about adoption + edge cases | [FAQ](./04-faq.md) |
| Run the first smoke test right now | [Quick start](./00-quick-start.md) |
| Browse the built-in checks | [Checks reference](../70-reference/05-checks-index.md) |
