---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Migrate from ESLint"
audience: [getting-started, ci-integrators]
purpose: "Task-led: when an ESLint rule belongs in opensip-tools, when it doesn't, and how the two tools coexist in one CI pipeline."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
related-docs:
  - ../00-start/03-vs-other-tools.md
  - ./02-ban-an-api-pattern.md
  - ./03-wire-into-ci.md
---
# Migrate from ESLint

opensip-tools doesn't replace ESLint. The two tools coexist comfortably in the same CI pipeline — ESLint handles language-specific syntactic patterns inside one file; opensip-tools handles architectural, cross-file, and cross-language rules that ESLint can't express. This guide walks the practical question: *given an ESLint rule we currently enforce, where does it belong?*

## The decision tree

```
┌─ Is the rule about a single language's syntax / idioms?
│  (no-unused-vars, prefer-const, formatting, JSX idioms)
│     → Keep it in ESLint. opensip-tools won't help here.
│
├─ Is the rule about a banned API or pattern within one file?
│  (no-console, no-eval, no-debugger, no-restricted-imports)
│     → Either works. ESLint is fine. opensip-tools wins if you want
│       to enforce the same ban across TypeScript + Python + Go.
│
├─ Is the rule about file structure or cross-file relationships?
│  (every package has a README, no circular imports, no cross-layer
│  imports between architectural layers)
│     → opensip-tools. ESLint can't see across files coherently.
│
├─ Is the rule about cross-language consistency?
│  (no console.log in any language, every public function has docs,
│  cross-language API contracts match)
│     → opensip-tools. ESLint is language-locked.
│
└─ Is the rule about static call-graph shape?
   (orphan code, dead paths, duplicated function bodies)
      → opensip-tools `graph` (different command). ESLint can't.
```

## What to move, what to keep

| Type of rule | ESLint | opensip-tools | Notes |
|---|---|---|---|
| `no-unused-vars`, `prefer-const`, formatting | ✓ keep | — | Linter sweet spot. |
| `no-console`, `no-debugger`, `no-eval` | ✓ keep | could move | Either works. Move if you want one rule across languages. |
| `no-restricted-imports` (in-file) | ✓ keep | could move | ESLint's is faster; opensip-tools's is more flexible. |
| "No module under `packages/cli/` may import from `packages/checks-*`" | ✗ can't | ✓ — sweet spot | This is the canonical architectural rule. |
| "Every package directory has a README" | ✗ can't | ✓ | File-structure rule. ESLint doesn't see directories. |
| "No circular imports across packages" | partial | ✓ better | ESLint plugins exist but break on monorepo boundaries. |
| "No FIXME comments in `packages/api/`" | ✓ (eslint-plugin-no-todo) | ✓ | Either works. opensip-tools wins if you want different rules per directory. |
| "Cross-language: no `console.log` / `print` / `fmt.Println`" | ✗ language-locked | ✓ — sweet spot | One rule, polyglot. |
| Static call-graph: orphan code, dead paths | ✗ | ✓ (`graph`) | ESLint can't see across files. |

The honest summary: **ESLint stays in your toolchain.** opensip-tools adds capabilities ESLint doesn't have, but doesn't replace ESLint's core competence.

## A coexisting CI pipeline

```yaml
# .github/workflows/ci.yml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run lint         # ESLint — syntactic, in-file rules

  fit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g opensip-tools
      - run: opensip-tools fit --gate-compare \
               --report-format sarif --report-out fit.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: fit.sarif, category: opensip-fit }
```

Two jobs, run in parallel. ESLint's output lands in the PR via its own conventions (or `actions/eslint-annotate`); opensip-tools's lands via the SARIF upload.

## Don't double-enforce

When you do move a rule from ESLint to opensip-tools, **disable it in ESLint**. Running the same rule in both tools doubles findings on every PR, doubles the maintenance burden, and confuses developers about which tool owns it.

Worked example: you decide `no-console` should be polyglot across your TS + Python + Go codebase, so you write an opensip-tools check for it. In ESLint, set the rule to `off`:

```jsonc
// .eslintrc.json
{
  "rules": {
    "no-console": "off",   // moved to opensip-tools (polyglot)
    "no-unused-vars": "error",
    // ...
  }
}
```

Document the move in a code comment or a `MIGRATIONS.md` so the next engineer doesn't reintroduce the ESLint rule.

## Migrating gradually

You don't need to move everything at once. The pragmatic path:

1. **Keep ESLint as is.** Don't touch it on day one.
2. **Add opensip-tools alongside** with one or two architectural rules ESLint can't express.
3. **Pick rules to move only when there's a real reason** — cross-language consistency, monorepo-aware scoping, file-structure rules. A rule that works fine in ESLint and only runs against one language has no reason to move.
4. **When you do move, disable the ESLint version in the same PR.** No drift period.

Some teams never move anything from ESLint — they just add opensip-tools as a *layer above* and keep ESLint untouched. That's a totally valid end state.

## Where to go next

| You want to … | Go to … |
|---|---|
| See concrete code for a banned-API check (which ESLint also handles) | [Ban an API pattern](/docs/opensip-tools/60-guides/02-ban-an-api-pattern/) |
| See the full ESLint / Semgrep / Sonarqube / Snyk comparison | [vs. other tools](/docs/opensip-tools/00-start/03-vs-other-tools/) |
| Add opensip-tools to your CI pipeline | [Wire into CI](/docs/opensip-tools/60-guides/03-wire-into-ci/) |
| Write your first architectural rule | [Write your first check](/docs/opensip-tools/60-guides/01-write-your-first-check/) |
