<!-- @fitness-ignore-file file-length-limit -- top-level project README; structural docs grow organically and serve as the project landing page -->

# OpenSIP CLI

[![npm](https://img.shields.io/npm/v/opensip-cli)](https://www.npmjs.com/package/opensip-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-opensip.ai-2563eb)](https://opensip.ai/docs/opensip-cli/)
[![OpenSIP](https://img.shields.io/badge/part%20of-OpenSIP-7c3aed)](https://opensip.ai)

> **OpenSIP CLI is part of [OpenSIP](https://opensip.ai)** — our developer-productivity platform. Visit **[opensip.ai](https://opensip.ai)** for the full picture.

> **One CLI to measure, map, and gate the health of any codebase.**

Run ~165 fitness checks across **TypeScript, Python, Go, Java, Rust, and C/C++**,
build a static call graph of your whole repo, and wire both into CI so quality
only goes up — from a single tool, on your laptop or in your pipeline.

OpenSIP CLI is a **collection of tools, not a single tool**. Today it ships
with three — `fit` (fitness checks), `graph` (static call-graph analysis), and
`sim` (simulation scenarios, experimental) — and adding a new one is a plugin
operation: install a package that implements the
[Tool contract](#tool-plugin-architecture) and the CLI picks it up
automatically, so the CLI grows without ever being rewritten.

### Why teams use it

- **🌐 Polyglot quality in one command.** `opensip fit` grades a
  mixed-language monorepo with one unified report — no per-language linter zoo to
  assemble and maintain.

- **📈 Adopt on a legacy repo without the wall of red.** Native **GitHub Code
  Scanning** integration with a net-new ratchet: your existing backlog goes into
  a baseline, and only *brand-new* violations surface inline on PR diffs.

- **🕸️ See your call graph and blast radius.** `opensip graph` maps
  function-level dependencies across five languages and flags what bites you in
  review — oversized functions, untested high-blast-radius code, cycles, and
  cross-package copy-paste — with an interactive visual dashboard.

- **📄 One shareable HTML report.** `opensip dashboard` emits a
  self-contained, server-free report aggregating every tool's findings. Attach it
  to a PR or hand it to a teammate — no SaaS login required.

- **📐 Make your ADRs enforceable — and make it your quality bar.** An
  architecture decision nobody checks is a decision that quietly erodes. Encode
  the rule behind each ADR as a custom check in a few lines with `defineCheck()`,
  bundle checks into named recipes, or ship a whole new tool as a plugin — your
  extensions are first-class, not bolted on. OpenSIP CLI dogfoods this: 20+ of
  its own bundled checks enforce its documented architecture decisions.

**In ten seconds:** measure your code, map it, and gate it — in any language,
from one CLI.

## Upgrading from v1.x to v2.x

v2.0.0 swaps internal runtime persistence from JSON files to SQLite. **v2 ignores
v1's `<project>/opensip-cli/.runtime/` contents** and initializes a fresh
`datastore.sqlite` on first run. Caches rebuild automatically; session history
from v1 is **not preserved**. The `--baseline <path>` flag is removed — there is
now exactly one gate baseline per project, stored in the project's SQLite database.

If you depend on the v1 layout (committed `baseline.sarif`, scripts that read
`.runtime/sessions/*.json`, etc.), pin to v1.x. See the v2.0.0 entry in
[CHANGELOG.md](CHANGELOG.md) for details.

## Quick start

Four commands from zero to a passing fitness run:

```bash
# 1. Install the CLI globally
curl -fsSL https://opensip.ai/cli/install.sh | bash

# 2. Change into your project's repo
cd your-project

# 3. Scaffold the project layout (detects language, writes config + examples)
opensip init

# 4. Smoke-test the install — runs the example check, then the example scenario
opensip fit --recipe example
opensip sim --recipe example
```

Both example commands should pass. From there, edit (or delete) the example
files under `opensip-cli/{fit,sim}/`, write your own checks and scenarios,
and run `opensip fit` (no recipe flag) to use the default recipe.

**Install from source?**

```bash
git clone https://github.com/opensip-ai/opensip-cli.git
cd opensip-cli && pnpm i && pnpm build
node packages/cli/dist/index.js fit
```

**Updating or removing later?** See [Updating & uninstalling](#updating--uninstalling).

## OpenSIP — the bigger picture

OpenSIP CLI is the open-source CLI. **OpenSIP**, our hosted developer-productivity platform, is where teams take this beyond one developer's terminal — visit **[opensip.ai](https://opensip.ai)** to see what's there.

### Sending CLI results to OpenSIP

OpenSIP CLI posts findings to any SARIF-compatible endpoint, including OpenSIP:

```bash
# One-time setup (interactive prompt for your API key)
opensip configure

# Then send findings on every run
opensip fit --report-to https://your-opensip-instance/api/ingest

# Or pass the key per-invocation
opensip fit --report-to https://your-opensip-instance/api/ingest --api-key sk-...
```

Findings are posted in SARIF 2.1.0 format with automatic retry on network failures.

API key resolution: `--api-key` flag > `cli.apiKey` in project config > `OPENSIP_API_KEY` env var > `~/.opensip-cli/config.yml`.

## What `init` writes

`opensip init` detects your project's primary language(s) from
filesystem markers (`Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`,
`build.gradle`, `CMakeLists.txt`, `tsconfig.json`, `package.json`) and
scaffolds:

```
your-project/
├── opensip-cli.config.yml                ← project config
├── opensip-cli/
│   ├── fit/
│   │   ├── checks/example-check.mjs        ← demo check, scope matches your language
│   │   └── recipes/example-recipe.mjs      ← runs the demo check
│   └── sim/
│       ├── scenarios/example-scenario.mjs  ← demo scenario
│       └── recipes/example-recipe.mjs      ← runs the demo scenario
└── .gitignore                              ← adds opensip-cli/.runtime/
```

Polyglot projects (e.g. Rust + TypeScript) get one example check per
language. To override detection or pick a polyglot configuration
explicitly:

```bash
opensip init --language rust              # explicit single language
opensip init --language rust,typescript   # polyglot
opensip init --keep                       # re-init, preserve custom files
opensip init --remove                     # re-init, scrap opensip-cli/ first
```

Re-running `init` on an already-initialized (or partially-initialized)
project refuses with exit 2 by default — pick `--keep` (re-scaffold
examples, preserve any custom files) or `--remove` (delete
`opensip-cli/` entirely, then scaffold fresh). The two flags are
mutually exclusive.

After the smoke tests pass, edit (or delete) the example files and
write your own. The plugin loader auto-discovers anything under
`opensip-cli/{fit,sim}/`, so adding a new `.mjs` file is enough — no
config change required.

## First-run alternatives

```bash
opensip fit                 # runs the default recipe (all enabled checks)
opensip fit --verbose       # + detailed per-violation output
opensip fit --list          # browse the check catalog
```

If `opensip fit` reports zero checks ran, you likely need a
targets file — `opensip init` writes one (see
[Configuration](#configuration)).

## Commands

### `fit` — fitness checks
```bash
opensip fit                   # run all checks (default recipe)
opensip fit --recipe <name>   # use a named recipe (e.g. quick-smoke, backend)
opensip fit --check <slug>    # run a single check
opensip fit --tags <tags>     # filter by tag (comma-separated)
opensip fit --verbose         # show per-violation detail
opensip fit --json            # structured JSON (for CI)
opensip fit --list            # list available checks
opensip fit --recipes         # list available recipes
opensip fit --gate-save       # save current findings as architecture baseline
opensip fit --gate-compare    # compare against baseline; exit 1 on regression
```

### Project setup & dashboards
```bash
opensip init                  # detect language, scaffold opensip-cli/ layout
opensip init --language <l>   # override detection (comma-separated for polyglot)
opensip init --keep           # re-init, preserve custom files (mutex with --remove)
opensip init --remove         # re-init, blow away opensip-cli/ first
opensip configure             # set up OpenSIP Cloud API key (interactive)
opensip dashboard             # HTML report — opens in browser
opensip sessions list         # run history
opensip sessions show latest --tool fit   # replay a stored run
opensip sessions purge        # delete session data (prompts for confirm)
```

### Plugins
```bash
opensip plugin list           # installed plugins
opensip plugin add <pkg>      # install + pin to opensip-cli.config.yml
opensip plugin remove <pkg>   # uninstall + unpin
opensip plugin sync           # reinstall pinned plugins after a fresh clone
```

### `sim` — resilience scenarios *(experimental · community-driven)*

`sim` is our youngest tool, and we're building it in the open. It lets you
describe **chaos** and **load** scenarios as code — with personas, invariants,
and assertions — and run them through a pluggable scenario engine.

**Honest status:** today `sim` executes scenarios *synthetically* (the engine
models outcomes rather than driving a live system), so it's a sandbox for the
authoring model and the reporting loop — not yet a production resilience test.
The next milestone is a **bring-your-own-target harness** that runs the same
scenarios against a real endpoint.

That gap is exactly why it's here. The scenario contract, the chaos/load kinds,
and the gate plumbing are real and stable; the live-execution layer is wide
open. If resilience testing is your thing, this is a tool you can shape from the
ground floor — **[issues and PRs welcome](https://github.com/opensip-ai/opensip-cli/issues)**.

```bash
opensip sim                   # run all scenarios (default recipe)
opensip sim --recipe example  # try the scenario model on the scaffolded demo
```

### `graph` — static call-graph analysis
```bash
opensip graph                 # run all rules, terminal report
opensip graph --json          # SignalEnvelope-shaped JSON (for CI)
opensip graph --no-cache      # skip the catalog cache; re-run stages 1+2
opensip graph --gate-save     # save current signals as baseline
opensip graph --gate-compare  # compare against baseline; exit 1 on new signals
opensip graph --report-to <url>  # POST SARIF 2.1.0 to an endpoint
opensip graph packages/core      # scope to one or more subtrees (faster)
opensip graph --workspace        # fan across every detected workspace unit in parallel
opensip graph --list-files       # print the files graph would discover (no build); add --json for { count, files }
```

Positional `[paths...]` scope the run to one or more existing directories (absolute or relative to `--cwd`); the shell handles any globs (`graph 'packages/*/src'`). Useful on monorepos where a global run is slow: a scoped run typically completes in seconds and fits easily in the default Node heap. The trade-off is fidelity — call sites that cross the in-scope boundary become unresolved, so the orphan-subtree and other reachability rules report against the in-scope subtree(s) only. Positional paths are mutually exclusive with `--workspace`.

Python, Rust, Go, and Java projects are also supported (lower fidelity, name-based resolution) via tree-sitter adapters that share the `@opensip-cli/graph-adapter-common` scaffolding. The Python adapter detects projects with `pyproject.toml` / `setup.py`; call edges resolve by simple name and carry `confidence: 'medium'` (or `'low'` for ambiguous matches). Pass `--language <name>` to force a specific adapter and suppress auto-detection.

The `--workspace` flag fans out across every detected workspace unit, running one memory-isolated child process per unit (polyglot-aware). Cross-unit edges remain unresolved per child, but the run covers the whole repo. Tune the parallelism with `--concurrency <n>` (default: `cpus()-1`). On opensip-cli's workspace this is roughly 2× faster than the global run; on monorepos with many units the speedup grows with cores.

For users who prefer external orchestration, `xargs -P 8 -I {} opensip graph {}` over a list of subtree paths achieves the same effect.

Ten rules ship today: `orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`, `large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`. The rules are deliberately opinionated and low-noise — each is meant to surface an *actionable* finding rather than raw graph trivia. `duplicated-function-body` flags functions whose bodies are byte-identical across **different packages** as consolidation candidates (a `minCrossPackageDuplicatePackages` knob tunes the threshold); `orphan-subtree` reports whole unreachable subtrees rather than every individually-unreferenced function. Output is grouped by rule with the top 10 findings per rule plus a summary; the full set is always available via `--json`. See [the graph loop docs](./docs/public/40-graph/) for what each rule detects and how the gate workflow integrates with CI.

Exploratory insights that are *not* gating rules — the per-package coupling grid, blast radius (most-depended-upon functions), strongly-connected components, and an interactive node-link visualizer — live in the dashboard's **Code Paths** views (see [Dashboard](#dashboard)), built from the same catalog.

#### Heap sizing on large monorepos

For TypeScript projects, `graph` builds a single TypeScript program over every `.ts`/`.tsx` file in the project's `tsconfig.json`. On large monorepos the program plus bound symbol table can exceed Node's default ~4 GB heap. When `graph` detects more than 1000 source files it prints a one-line hint to stderr at startup; if it OOMs, retry with a larger heap:

```bash
NODE_OPTIONS=--max-old-space-size=8192 opensip graph     # most monorepos
NODE_OPTIONS=--max-old-space-size=12288 opensip graph    # very large repos
```

Measured: a 5476-file repo OOM'd at 4 GB after ~17 min, completed at 12 GB in ~25 min with ~4.2 GB peak resident. The 8 GB setting is the recommended default once you cross the threshold. (Heap pressure is most acute for the TypeScript adapter; the tree-sitter adapters parse files lazily and use far less memory.)

#### Incremental rebuild

Once a catalog is cached on disk, subsequent runs only re-walk source files whose mtime or size has changed. The dependency closure is expanded transitively: any unchanged file whose cached call edges point at a hash that vanished after the re-walk is also re-walked, until the closure is closed. This guarantees no stale edges in the merged catalog — the result is byte-identical to a `--no-cache` full rebuild.

On opensip-cli self-graph, editing a single file drops rebuild time from ~15 s (full) to ~2.6 s (incremental), with no fidelity loss. Use `--no-cache` to force a full rebuild.

### Standalone listing commands

These mirror the `fit --list` / `fit --recipes` flags but work as
top-level commands too:

```bash
opensip fit-list
opensip fit-recipes
```

## Fitness Checks

Run `opensip fit` to scan your codebase. Default output is a compact summary:

```
120 Passed, 10 Failed (423 Errors, 227 Warnings) | Duration 8.1s
```

Use `--verbose` for detailed violation output.

### Options

```bash
opensip fit                               # Run all checks (default recipe)
opensip fit --cwd /path/to/project        # Target a different directory
opensip fit --recipe quick-smoke          # Use a named recipe
opensip fit --check no-console-log        # Run a single check
opensip fit --tags security               # Filter by tag
opensip fit --exclude no-any-types        # Exclude specific checks
opensip fit --report-to http://localhost:4919  # Send SARIF to OpenSIP
opensip fit --debug                       # Structured log output to stderr
```

### Recipes

Pre-defined check sets for common scenarios:

| Recipe | Description |
|--------|------------|
| `default` | All enabled checks |
| `quick-smoke` | Fast critical checks |
| `backend` | Backend-focused (architecture, resilience) |
| `frontend` | Frontend-focused (React, accessibility) |
| `security` | Comprehensive security analysis |
| `pre-commit` | Fast checks for git pre-commit hooks |
| `pre-release` | Comprehensive checks before release |
| `nightly-full` | Complete suite for nightly scheduled runs |
| `ci` | Optimized for CI pipelines with JSON output |
| `architecture` | Architecture validation and compliance |

### Check Tags

Checks are organized by tags: `security`, `quality`, `architecture`, `modularity`, `testing`, `resilience`, `observability`, `accessibility`, and more. Use `--tags` to filter or `--list` to browse all checks.

## Configuration

`opensip init` writes `opensip-cli.config.yml` at your project
root with one named target per detected language. For a Rust project:

```yaml
# opensip-cli.config.yml

globalExcludes:
  - "**/node_modules/**"
  - "**/dist/**"

targets:
  rust-source:
    description: Rust source code
    languages: [rust]
    concerns: [backend]
    include:
      - "src/**/*.rs"
      - "crates/**/*.rs"
      - "services/**/*.rs"
    exclude:
      - "**/target/**"

fitness:
  failOnErrors: 1      # Exit code 1 if errors >= this (default: 1)
  failOnWarnings: 0    # Exit code 1 if warnings >= this (default: 0, warnings don't fail)
  disabledChecks: []
```

For a polyglot project, init writes one named target per language
(`rust-source:`, `typescript-source:`, etc.) so checks can scope to
each language independently.

### CI/CD Exit Codes

By default, any check error causes exit code 1 (CI fails). Configure thresholds:

- `failOnErrors: 1` — fail if total errors >= 1 (default)
- `failOnErrors: 0` — report-only mode, never fail on errors
- `failOnWarnings: 1` — strict mode, warnings also cause failure

## Architecture Gate

Catch architectural regressions during code reviews, AI-agent coding sessions, or pre-commit hooks. The gate is a baseline-and-compare workflow: snapshot your current state, then compare future runs against that snapshot.

This is also the natural home for **enforcing your ADRs**: encode the rule each decision establishes as a check, and the gate turns "we agreed not to do that" into a build failure on the PR that does it.

```bash
# Before making changes — save a baseline
opensip fit --gate-save

# After making changes — compare
opensip fit --gate-compare
```

Output of `--gate-compare`:

```
opensip gate compare

Added (2):
  ✗ fit:circular-import      packages/foo/x.ts → y.ts
  ✗ fit:complex-function     packages/foo/z.ts:88 (cc=28, was 22)

Resolved (1):
  ✓ fit:dead-code            packages/foo/y.ts:10

✗ DEGRADED — 2 new violations introduced
```

**Exit codes:**
- `0` — no new violations (baseline preserved or improved)
- `1` — regression detected (at least one new violation)
- `2` — config error (missing baseline, malformed SARIF)

**Baseline storage:** the gate baseline lives in the project's
`datastore.sqlite` (under `<cwd>/opensip-cli/.runtime/`, gitignored
automatically by `opensip init`). There is exactly one baseline per
project — `--gate-save` writes it and `--gate-compare` reads it. To export the
current baseline to a portable SARIF file (e.g. for GitHub Code Scanning), use
`fit-baseline-export --out <path>`.

**How diffs are matched:** by `(filePath, ruleId, message)` tuple. Line numbers are intentionally **not** in the matching key — unrelated edits that shift lines won't register as false-positive added/resolved entries.

### Use case: AI-agent fix pipelines

Before letting an AI agent modify your code, save a baseline:

```bash
opensip fit --gate-save
# … agent makes changes …
opensip fit --gate-compare || echo "Architecture degraded — review changes"
```

Combined with `--report-to` and the dashboard, you get a continuous record of every agent session's architectural impact.

## Plugins

Plugins are project-local. Two kinds:

**User-authored source files** — drop a `.mjs` file into the
appropriate directory and it auto-loads:

```
opensip-cli/
  fit/
    checks/      ← .mjs exporting `checks`  (auto-loaded)
    recipes/     ← .mjs exporting `recipes` (auto-loaded)
  sim/
    scenarios/   ← .mjs exporting `scenarios` (auto-loaded)
    recipes/     ← .mjs exporting `recipes`   (auto-loaded)
```

No config opt-in required. `opensip init` scaffolds working
example files in each of these directories.

**npm-installed plugin packages** — explicit pinning in the config.
The pinned packages are installed under
`opensip-cli/.runtime/plugins/<domain>/node_modules/`:

```bash
opensip plugin add @company/checks-custom    # installs + pins
opensip plugin remove @company/checks-custom  # uninstalls + unpins
opensip plugin list                           # what's installed
opensip plugin sync                           # reinstall after a fresh clone
```

`plugin add` updates the `plugins.<domain>` list in
`opensip-cli.config.yml` so the install is reproducible across
machines. Marker-based discovery also runs for packages that declare
`opensipTools.kind`; transitive dependencies that lack an opensip-cli
marker do not auto-load.

```yaml
# opensip-cli.config.yml
plugins:
  fit:
    - "@company/checks-custom"
```

### Authoring a check package

Your check pack is an ordinary npm package that exports a `checks` and/or
`recipes` array. Declare `@opensip-cli/fitness` as a **peer dependency** —
this lets the host and your pack share one Check / Signal shape and avoids
version drift.

`fitness` (not `core`) is the right peer because `defineCheck`, `Check`,
`CheckViolation`, and the recipe types all live in the fitness engine
package. `core` is the kernel (errors, logger, language adapters, plugin
loader) — packs that import only those can peer-depend on `core`, but most
won't need to.

**`package.json`**

```json
{
  "name": "@my-org/fitness-checks",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": {
    "@opensip-cli/fitness": "^3.0.0"
  },
  "devDependencies": {
    "@opensip-cli/fitness": "^3.0.0",
    "typescript": "^5.7.0"
  }
}
```

**`src/index.ts`**

```typescript
import { defineCheck, type Check, type CheckDisplayEntry } from '@opensip-cli/fitness';

const myCheck: Check = defineCheck({
  id: '3f7a…-uuid',
  slug: 'my-custom-check',
  description: 'What this check enforces',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['custom'],
  analyze: (content, filePath) => {
    const violations = [];
    // detection logic
    return violations;
  },
});

export const checks: readonly Check[] = [myCheck];

// Optional — contribute display names that the CLI's table / dashboard
// renders for your slugs (icon + human-readable label).
export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'my-custom-check': ['🔍', 'My Custom Check'],
};

// Optional — ship recipes alongside checks
export const recipes = [{
  id: 'URCP_my-org',
  name: 'my-org',
  displayName: 'My Org',
  description: 'All my-org checks',
  checks: { type: 'tags', include: ['custom'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

#### Discovery

Any installed npm package declaring `opensipTools.kind: "fit-pack"` is
auto-discovered by the CLI — no `plugin install` step needed. Run
Add `@my-org/fitness-checks` to your project dependencies and the
CLI loads it on the next `fit` run.

For packages that do not declare the marker yet, list them by exact name in
your project's `opensip-cli.config.yml`:

```yaml
plugins:
  checkPackages:
    - "@my-org/fitness-checks"
```

This exact list supplements marker-based discovery.

**Why peer dependency?** Check packs return Check objects that the host
registers and executes; they don't mutate host singletons. Declaring
`@opensip-cli/fitness` as a peer means one copy of the fitness engine
serves every loaded pack, so peer resolution is clean and version
expectations are explicit. This mirrors the ESLint / Rollup plugin model.

### Single-file plugins

For quick local experiments, drop a `.mjs` file in
`opensip-cli/fit/checks/`:

```javascript
// opensip-cli/fit/checks/my-check.mjs
import { defineCheck } from '@opensip-cli/fitness';

export const checks = [
  defineCheck({
    id: 'custom-uuid-here',
    slug: 'my-custom-check',
    description: 'My custom check',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['custom'],
    analyze: (content, filePath) => {
      // your logic
      return [];
    },
  }),
];
```

`@opensip-cli/fitness` resolves from the global CLI install or from your project's
`node_modules` (when installed as a local devDependency). For pure
single-file plugins with no other package setup, install the CLI globally
with the curl installer — that's the supported path.

### Recipes

Recipes are named check or scenario bundles — useful when you want to
run a specific set across multiple repos:

```javascript
// opensip-cli/fit/recipes/my-recipes.mjs
export const recipes = [{
  id: 'URCP_backend-strict',
  name: 'backend-strict',
  displayName: 'Backend Strict',
  description: 'All my checks plus opensip-cli backend checks',
  checks: { type: 'all', exclude: [] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

Then: `opensip fit --recipe backend-strict`. Sim recipes work
the same way under `opensip-cli/sim/recipes/` and run via
`opensip sim --recipe <name>`.

## CI Integration

### GitHub Actions

```yaml
- name: Run fitness checks
  run: opensip fit --json > fitness-report.json

- name: Upload to OpenSIP
  run: opensip fit --report-to ${{ secrets.OPENSIP_URL }} --api-key ${{ secrets.OPENSIP_KEY }}
```

### JSON Output

Since 2.12.0 (ADR-0024), `--json` emits **one `CommandOutcome` wrapper** on
stdout; the `SignalEnvelope` rides under `.envelope`:

```json
{
  "kind": "fit.run",
  "status": "error",
  "exitCode": 1,
  "envelope": {
    "schemaVersion": 2,
    "tool": "fit",
    "runId": "RUN_01JZ8Q0Z7R8V8R4N4Y8QXJ0X9H",
    "createdAt": "2026-06-07T18:00:00.000Z",
    "verdict": {
      "score": 92,
      "passed": false,
      "summary": {
        "total": 124,
        "passed": 120,
        "failed": 4,
        "errors": 12,
        "warnings": 45
      }
    },
    "units": [
      {
        "slug": "no-console-log",
        "passed": false,
        "violationCount": 1,
        "filesValidated": 312,
        "itemType": "files",
        "durationMs": 150
      }
    ],
    "signals": [
      {
        "id": "sig_a3f9c204e1b2",
        "source": "no-console-log",
        "provider": "opensip-cli",
        "severity": "high",
        "category": "quality",
        "ruleId": "fit:no-console-log",
        "message": "console.log found in production code",
        "suggestion": "Replace with a structured logger",
        "filePath": "src/utils.ts",
        "line": 42,
        "metadata": {},
        "createdAt": "2026-06-07T18:00:00.000Z"
      }
    ]
  },
  "diagnostics": { }
}
```

Every tool emits this `CommandOutcome` shape on `--json`, with the
byte-identical `SignalEnvelope` under `.envelope` (list/dashboard commands carry
their result under `.data`; failures carry structured `errors`). The stable CI
fields are `.envelope.verdict.passed`, `.envelope.verdict.score`,
`.envelope.verdict.summary`, `.envelope.units[]`, and the flat
`.envelope.signals[]` list — e.g. `opensip fit --json | jq
'.envelope.verdict.passed'`. See [JSON output
schema](./docs/public/70-reference/04-json-output-schema.md) for the full field
table and the 2.12.0 migration notes.

## Dashboard

Generate an HTML report with session history:

```bash
opensip dashboard
```

The dashboard shows:
- Run history with trends
- Per-check results and pass rates
- Check catalog with tags and confidence levels
- Recipe catalog
- **Code Paths** — call-graph views built from the `graph` catalog: a
  per-package coupling grid, blast radius (most-depended-upon functions),
  hot/wide/big function lists, strongly-connected components, untested
  reachable code, and an interactive node-link graph visualizer

## Session Management

```bash
opensip sessions list                  # Show run history
opensip sessions show <id>             # Replay a stored session (or `latest --tool fit`)
opensip sessions purge                 # Delete all sessions (prompts y/n)
opensip sessions purge --older-than 7  # Delete sessions older than 7 days
opensip sessions purge --yes           # Skip confirmation
```

## Updating & uninstalling

### Update

```bash
# Update to the latest release
curl -fsSL https://opensip.ai/cli/install.sh | bash

# Check the installed version
opensip --version
```

The CLI checks npm once per day in interactive shells and prints a one-line
notice on stderr when a newer version is available. The check is suppressed
in CI, non-TTY pipelines, and `--json` invocations; opt out entirely with
`OPENSIP_NO_UPDATE=1` (or the upstream `NO_UPDATE_NOTIFIER=1`).

Release notes for every version live in
[`CHANGELOG.md`](./CHANGELOG.md).

### Uninstall

Removal is split into three independent steps so each can be done in
isolation — most users only need the first.

```bash
# 1. Project runtime state — sessions, cache, logs, and baselines in one repo
opensip uninstall --project                 # cwd
opensip uninstall --project /path/to/repo   # explicit path

# 2. User-level config — cloud API key + per-user defaults
opensip uninstall

# 3. The CLI binary itself
npm uninstall -g opensip-cli               # or: pnpm rm -g opensip-cli
```

The running binary can't safely self-delete, so step 3 is always a separate
`npm uninstall`. Steps 1 and 2 both support:

- `--dry-run` — print every target path and total size, take no action.
- `--yes` / `-y` — skip the `[y/N]` confirmation prompt (intended for scripts).

Project-mode uninstall removes only the rebuildable `.runtime/` state by
default. Your authored content (custom checks, recipes, scenarios) and
`opensip-cli.config.yml` are preserved.

To remove everything — including authored content and the config — pass
`--purge`. `--purge` is destructive: if your custom checks aren't committed
to git, you'll lose them. We recommend running `git status` first.

Both modes refuse to run when no OpenSIP CLI state exists at the
resolved path, so an accidental `--project /unrelated/dir` is a no-op
rather than a destructive accident.

### Where state lives

| Path | Tracked by git? | Removed by default | Removed by `--purge` |
|---|---|---|---|
| `~/.opensip-cli/config.yml` | no — user-level | `opensip uninstall` (user mode) | — |
| `<project>/opensip-cli.config.yml` | yes — project config | (kept) | `opensip uninstall --project --purge` |
| `<project>/opensip-cli/.runtime/` | no — runtime state | `opensip uninstall --project` | `opensip uninstall --project --purge` |
| `<project>/opensip-cli/<user-content>/` (custom checks, recipes, scenarios) | yes — user-authored | (kept) | `opensip uninstall --project --purge` |

## Observability

Every CLI invocation generates a `runId` (prefixed ULID — `RUN_<26char>`)
for log correlation. Structured JSON logs are written to
`<project>/opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl` (gitignored).
Sessions live in the project SQLite store at
`<project>/opensip-cli/.runtime/datastore.sqlite`. HTML reports are written to
`<project>/opensip-cli/.runtime/reports/latest.html`.

```bash
opensip fit --debug    # Show structured log events on stderr
```

Logs are written to a daily JSONL file; files older than 7 days are
pruned automatically on the next run.

## Architecture

For the full educational walkthrough — the fitness loop end-to-end, the
tool-plugin model, the layer cake, the pipeline subsystems, and a
lookup-shaped package catalog — see [`docs/public/README.md`](./docs/public/README.md).
What follows here is a one-page overview.

Turborepo + pnpm monorepo. Layered: lower numbers depend only on
higher numbers, never the other direction. Architecture rules are
enforced in CI by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser).

```
packages/
  core/                    # @opensip-cli/core — kernel: errors, logger, IDs,
                           #   language adapters, plugin loader, Registry/RunScope,
                           #   Tool contract
  contracts/               # @opensip-cli/contracts — contract types between
                           #   Tools and the runner: SignalEnvelope/CommandResult
                           #   shapes, exit codes, GraphCatalog surface
  datastore/               # @opensip-cli/datastore — SQLite + Drizzle persistence
  session-store/           # @opensip-cli/session-store — session persistence
  output/                  # @opensip-cli/output — SARIF / cloud report output
  dashboard/               # @opensip-cli/dashboard — self-contained HTML report
  cli-ui/                  # @opensip-cli/cli-ui — shared Ink/React primitives
  cli/                     # opensip-cli — generic tool dispatcher

  fitness/                 # @opensip-cli/fitness namespace
    engine/                # @opensip-cli/fitness — fit/fit-list/fit-recipes/gate
                           #   commands, recipe service, gate, SARIF
    checks-typescript/     # @opensip-cli/checks-typescript — TS-AST checks
    checks-universal/      # @opensip-cli/checks-universal — text/regex/glob checks
    checks-python/         # @opensip-cli/checks-python — Python (no-bare-except)
    checks-go/             # @opensip-cli/checks-go — Go (no-fmt-print)
    checks-java/           # @opensip-cli/checks-java — Java (no-printstacktrace)
    checks-cpp/            # @opensip-cli/checks-cpp — C/C++ (clang-tidy)
    checks-rust/           # @opensip-cli/checks-rust — Rust (no-dbg-macro)

  graph/                   # @opensip-cli/graph namespace
    engine/                # @opensip-cli/graph — language-agnostic graph kernel
    graph-adapter-common/  # shared tree-sitter scaffolding (discover/parse/walk/
                           #   cache-key) for the go/java/python/rust adapters
    graph-typescript/      # TS call-graph adapter (TypeScript compiler API)
    graph-python/          # Python call-graph adapter (tree-sitter)
    graph-rust/            # Rust call-graph adapter (tree-sitter)
    graph-go/              # Go call-graph adapter (tree-sitter)
    graph-java/            # Java call-graph adapter (tree-sitter)

  simulation/              # @opensip-cli/simulation namespace
    engine/                # @opensip-cli/simulation — sim command + scenarios

  languages/               # language adapters (@opensip-cli/lang-*)
    lang-typescript/       # TypeScript / TSX adapter
    lang-rust/             # Rust adapter (hand-written lexer)
    lang-python/           # Python adapter
    lang-go/               # Go adapter
    lang-java/             # Java adapter
    lang-cpp/              # C/C++ adapter (command-mode via clang-tidy)
```

### Tool plugin architecture

The CLI is a generic dispatcher. Each invocation constructs a fresh
`ToolRegistry` and loads every tool — bundled and installed alike —
through the same dynamic-import plugin path; there is no privileged
first-party fast path. Third-party tools are discovered automatically when
their `package.json` declares:

```json
{
  "opensipTools": { "kind": "tool" }
}
```

The `Tool` contract (`@opensip-cli/core/tools`) carries the tool's
metadata, command descriptors (for `--help` listings), and a declarative
`commandSpecs` array — the tool's only command surface. The host's
`mountCommandSpec` owns the Commander wiring and the
parse→handler→error→exit pipeline; tools never touch Commander and never
depend on the CLI package directly. They reach shared CLI infrastructure
(Ink rendering, dashboard auto-open, structured logging) through the
`ToolCliContext` they receive. This keeps the dependency graph acyclic and
lets a third-party tool ship without touching CLI source. (`apiVersion` is
mandatory as of the v3.0.0 GA cutover; the legacy `register(cli)` mount hook
was removed.)

To author a new tool, see the source of `packages/fitness/engine/src/tool.ts`
or `packages/simulation/engine/src/tool.ts`. The shape is small enough to
keep the contract honest.

---

## About OpenSIP

OpenSIP CLI is built and maintained by the team at [**OpenSIP**](https://opensip.ai). Visit **[opensip.ai](https://opensip.ai)** for OpenSIP itself — our hosted developer-productivity platform — and the rest of the product family.

This CLI is MIT-licensed and developed in the open at [github.com/opensip-ai/opensip-cli](https://github.com/opensip-ai/opensip-cli). Contributions welcome.

## License

MIT
