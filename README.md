<!-- @fitness-ignore-file file-length-limit -- top-level project README; structural docs grow organically and serve as the project landing page -->

# OpenSIP Tools

[![npm](https://img.shields.io/npm/v/opensip-tools)](https://www.npmjs.com/package/opensip-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-opensip.ai-2563eb)](https://opensip.ai/docs/opensip-tools/)
[![OpenSIP](https://img.shields.io/badge/part%20of-OpenSIP-7c3aed)](https://opensip.ai)

> **opensip-tools is part of [OpenSIP](https://opensip.ai)** — our developer-productivity platform. Visit **[opensip.ai](https://opensip.ai)** for the full picture.

Open-source codebase analysis toolkit. Run fitness checks against TypeScript, Rust, Python, Java, Go, or C/C++ codebases standalone, in CI, or as a regression detector around AI-agent coding sessions.

opensip-tools is a **collection of tools**, not a single tool. Today it ships
with three: `fit` (fitness checks), `graph` (static call-graph analysis), and
`sim` (simulation scenarios, experimental). Adding a new tool is a plugin
operation — install a package that implements the
[Tool contract](#tool-plugin-architecture) and the CLI picks it up automatically.

## Upgrading from v1.x to v2.x

v2.0.0 swaps internal runtime persistence from JSON files to SQLite. **v2 ignores
v1's `<project>/opensip-tools/.runtime/` contents** and initializes a fresh
`datastore.sqlite` on first run. Caches rebuild automatically; session history
from v1 is **not preserved**. The `--baseline <path>` flag is removed — there is
now exactly one gate baseline per project, stored in the project's SQLite database.

If you depend on the v1 layout (committed `baseline.sarif`, scripts that read
`.runtime/sessions/*.json`, etc.), pin to v1.x. See the v2.0.0 entry in
[CHANGELOG.md](CHANGELOG.md) for details.

## Quick start

Four commands from zero to a passing fitness run:

```bash
# 1. Install the CLI globally from npm
npm install -g opensip-tools

# 2. Change into your project's repo
cd your-project

# 3. Scaffold the project layout (detects language, writes config + examples)
opensip-tools init

# 4. Smoke-test the install — runs the example check, then the example scenario
opensip-tools fit --recipe example
opensip-tools sim --recipe example
```

Both example commands should pass. From there, edit (or delete) the example
files under `opensip-tools/{fit,sim}/`, write your own checks and scenarios,
and run `opensip-tools fit` (no recipe flag) to use the default recipe.

**No global install?** `npx opensip-tools fit` works for one-offs.
**Install from source?**

```bash
git clone https://github.com/opensip-ai/opensip-tools.git
cd opensip-tools && pnpm install && pnpm build
node packages/cli/dist/index.js fit
```

**Updating or removing later?** See [Updating & uninstalling](#updating--uninstalling).

## OpenSIP — the bigger picture

opensip-tools is the open-source CLI. **OpenSIP**, our hosted developer-productivity platform, is where teams take this beyond one developer's terminal — visit **[opensip.ai](https://opensip.ai)** to see what's there.

### Sending CLI results to OpenSIP

opensip-tools posts findings to any SARIF-compatible endpoint, including OpenSIP:

```bash
# One-time setup (interactive prompt for your API key)
opensip-tools configure

# Then send findings on every run
opensip-tools fit --report-to https://your-opensip-instance/api/ingest

# Or pass the key per-invocation
opensip-tools fit --report-to https://your-opensip-instance/api/ingest --api-key sk-...
```

Findings are posted in SARIF 2.1.0 format with automatic retry on network failures.

API key resolution: `--api-key` flag > `cli.apiKey` in project config > `OPENSIP_API_KEY` env var > `~/.opensip-tools/config.yml`.

## What `init` writes

`opensip-tools init` detects your project's primary language(s) from
filesystem markers (`Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`,
`build.gradle`, `CMakeLists.txt`, `tsconfig.json`, `package.json`) and
scaffolds:

```
your-project/
├── opensip-tools.config.yml                ← project config
├── opensip-tools/
│   ├── fit/
│   │   ├── checks/example-check.mjs        ← demo check, scope matches your language
│   │   └── recipes/example-recipe.mjs      ← runs the demo check
│   └── sim/
│       ├── scenarios/example-scenario.mjs  ← demo scenario
│       └── recipes/example-recipe.mjs      ← runs the demo scenario
└── .gitignore                              ← adds opensip-tools/.runtime/
```

Polyglot projects (e.g. Rust + TypeScript) get one example check per
language. To override detection or pick a polyglot configuration
explicitly:

```bash
opensip-tools init --language rust              # explicit single language
opensip-tools init --language rust,typescript   # polyglot
opensip-tools init --keep                       # re-init, preserve custom files
opensip-tools init --remove                     # re-init, scrap opensip-tools/ first
```

Re-running `init` on an already-initialized (or partially-initialized)
project refuses with exit 2 by default — pick `--keep` (re-scaffold
examples, preserve any custom files) or `--remove` (delete
`opensip-tools/` entirely, then scaffold fresh). The two flags are
mutually exclusive.

After the smoke tests pass, edit (or delete) the example files and
write your own. The plugin loader auto-discovers anything under
`opensip-tools/{fit,sim}/`, so adding a new `.mjs` file is enough — no
config change required.

## First-run alternatives

```bash
opensip-tools fit                 # runs the default recipe (all enabled checks)
opensip-tools fit --verbose       # + detailed per-violation output
opensip-tools fit --list          # browse the check catalog
```

If `opensip-tools fit` reports zero checks ran, you likely need a
targets file — `opensip-tools init` writes one (see
[Configuration](#configuration)).

## Commands

### `fit` — fitness checks
```bash
opensip-tools fit                   # run all checks (default recipe)
opensip-tools fit --recipe <name>   # use a named recipe (e.g. quick-smoke, backend)
opensip-tools fit --check <slug>    # run a single check
opensip-tools fit --tags <tags>     # filter by tag (comma-separated)
opensip-tools fit --verbose         # show per-violation detail
opensip-tools fit --json            # structured JSON (for CI)
opensip-tools fit --list            # list available checks
opensip-tools fit --recipes         # list available recipes
opensip-tools fit --gate-save       # save current findings as architecture baseline
opensip-tools fit --gate-compare    # compare against baseline; exit 1 on regression
```

### Project setup & dashboards
```bash
opensip-tools init                  # detect language, scaffold opensip-tools/ layout
opensip-tools init --language <l>   # override detection (comma-separated for polyglot)
opensip-tools init --keep           # re-init, preserve custom files (mutex with --remove)
opensip-tools init --remove         # re-init, blow away opensip-tools/ first
opensip-tools configure             # set up OpenSIP Cloud API key (interactive)
opensip-tools dashboard             # HTML report — opens in browser
opensip-tools sessions list         # run history
opensip-tools sessions purge        # delete session data (prompts for confirm)
```

### Plugins
```bash
opensip-tools plugin list           # installed plugins
opensip-tools plugin add <pkg>      # install + pin to opensip-tools.config.yml
opensip-tools plugin remove <pkg>   # uninstall + unpin
opensip-tools plugin sync           # reinstall pinned plugins after a fresh clone
```

### `sim` — simulations *(experimental)*
```bash
opensip-tools sim                   # run simulations
```

### `graph` — static call-graph analysis
```bash
opensip-tools graph                 # run all rules, terminal report
opensip-tools graph --json          # SignalEnvelope-shaped JSON (for CI)
opensip-tools graph --no-cache      # skip the catalog cache; re-run stages 1+2
opensip-tools graph --gate-save     # save current signals as baseline
opensip-tools graph --gate-compare  # compare against baseline; exit 1 on new signals
opensip-tools graph --report-to <url>  # POST SARIF 2.1.0 to an endpoint
opensip-tools graph packages/core      # scope to one or more subtrees (faster)
opensip-tools graph --workspace        # fan across every detected workspace unit in parallel
opensip-tools graph --list-files       # print the files graph would discover (no build); add --json for { count, files }
```

Positional `[paths...]` scope the run to one or more existing directories (absolute or relative to `--cwd`); the shell handles any globs (`graph 'packages/*/src'`). Useful on monorepos where a global run is slow: a scoped run typically completes in seconds and fits easily in the default Node heap. The trade-off is fidelity — call sites that cross the in-scope boundary become unresolved, so the orphan-subtree and other reachability rules report against the in-scope subtree(s) only. Positional paths are mutually exclusive with `--workspace`.

Python, Rust, Go, and Java projects are also supported (lower fidelity, name-based resolution) via tree-sitter adapters that share the `@opensip-tools/graph-adapter-common` scaffolding. The Python adapter detects projects with `pyproject.toml` / `setup.py`; call edges resolve by simple name and carry `confidence: 'medium'` (or `'low'` for ambiguous matches). Pass `--language <name>` to force a specific adapter and suppress auto-detection.

The `--workspace` flag fans out across every detected workspace unit, running one memory-isolated child process per unit (polyglot-aware). Cross-unit edges remain unresolved per child, but the run covers the whole repo. Tune the parallelism with `--concurrency <n>` (default: `cpus()-1`). On opensip-tools's workspace this is roughly 2× faster than the global run; on monorepos with many units the speedup grows with cores.

For users who prefer external orchestration, `xargs -P 8 -I {} opensip-tools graph {}` over a list of subtree paths achieves the same effect.

Ten rules ship today: `orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`, `large-function`, `wide-function`, `high-blast-untested`, `cycle`, `unexpected-coupling`. The rules are deliberately opinionated and low-noise — each is meant to surface an *actionable* finding rather than raw graph trivia. `duplicated-function-body` flags functions whose bodies are byte-identical across **different packages** as consolidation candidates (a `minCrossPackageDuplicatePackages` knob tunes the threshold); `orphan-subtree` reports whole unreachable subtrees rather than every individually-unreferenced function. Output is grouped by rule with the top 10 findings per rule plus a summary; the full set is always available via `--json`. See [the graph loop docs](./docs/public/40-graph/) for what each rule detects and how the gate workflow integrates with CI.

Exploratory insights that are *not* gating rules — the per-package coupling grid, blast radius (most-depended-upon functions), strongly-connected components, and an interactive node-link visualizer — live in the dashboard's **Code Paths** views (see [Dashboard](#dashboard)), built from the same catalog.

#### Heap sizing on large monorepos

For TypeScript projects, `graph` builds a single TypeScript program over every `.ts`/`.tsx` file in the project's `tsconfig.json`. On large monorepos the program plus bound symbol table can exceed Node's default ~4 GB heap. When `graph` detects more than 1000 source files it prints a one-line hint to stderr at startup; if it OOMs, retry with a larger heap:

```bash
NODE_OPTIONS=--max-old-space-size=8192 opensip-tools graph     # most monorepos
NODE_OPTIONS=--max-old-space-size=12288 opensip-tools graph    # very large repos
```

Measured: a 5476-file repo OOM'd at 4 GB after ~17 min, completed at 12 GB in ~25 min with ~4.2 GB peak resident. The 8 GB setting is the recommended default once you cross the threshold. (Heap pressure is most acute for the TypeScript adapter; the tree-sitter adapters parse files lazily and use far less memory.)

#### Incremental rebuild

Once a catalog is cached on disk, subsequent runs only re-walk source files whose mtime or size has changed. The dependency closure is expanded transitively: any unchanged file whose cached call edges point at a hash that vanished after the re-walk is also re-walked, until the closure is closed. This guarantees no stale edges in the merged catalog — the result is byte-identical to a `--no-cache` full rebuild.

On opensip-tools self-graph, editing a single file drops rebuild time from ~15 s (full) to ~2.6 s (incremental), with no fidelity loss. Use `--no-cache` to force a full rebuild.

### Standalone listing commands

These mirror the `fit --list` / `fit --recipes` flags but work as
top-level commands too:

```bash
opensip-tools fit-list              # alias: list-checks
opensip-tools fit-recipes           # alias: list-recipes
```

## Fitness Checks

Run `opensip-tools fit` to scan your codebase. Default output is a compact summary:

```
120 Passed, 10 Failed (423 Errors, 227 Warnings) | Duration 8.1s
```

Use `--verbose` for detailed violation output. `--findings` remains as a deprecated alias for older scripts.

### Options

```bash
opensip-tools fit                               # Run all checks (default recipe)
opensip-tools fit --cwd /path/to/project        # Target a different directory
opensip-tools fit --recipe quick-smoke          # Use a named recipe
opensip-tools fit --check no-console-log        # Run a single check
opensip-tools fit --tags security               # Filter by tag
opensip-tools fit --exclude no-any-types        # Exclude specific checks
opensip-tools fit --report-to http://localhost:4919  # Send SARIF to OpenSIP
opensip-tools fit --debug                       # Structured log output to stderr
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

`opensip-tools init` writes `opensip-tools.config.yml` at your project
root with one named target per detected language. For a Rust project:

```yaml
# opensip-tools.config.yml

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

```bash
# Before making changes — save a baseline
opensip-tools fit --gate-save

# After making changes — compare
opensip-tools fit --gate-compare
```

Output of `--gate-compare`:

```
opensip-tools gate compare

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
`datastore.sqlite` (under `<cwd>/opensip-tools/.runtime/`, gitignored
automatically by `opensip-tools init`). There is exactly one baseline per
project — `--gate-save` writes it and `--gate-compare` reads it. To export the
current baseline to a portable SARIF file (e.g. for GitHub Code Scanning), use
`fit-baseline-export --out <path>`.

**How diffs are matched:** by `(filePath, ruleId, message)` tuple. Line numbers are intentionally **not** in the matching key — unrelated edits that shift lines won't register as false-positive added/resolved entries.

### Use case: AI-agent fix pipelines

Before letting an AI agent modify your code, save a baseline:

```bash
opensip-tools fit --gate-save
# … agent makes changes …
opensip-tools fit --gate-compare || echo "Architecture degraded — review changes"
```

Combined with `--report-to` and the dashboard, you get a continuous record of every agent session's architectural impact.

## Plugins

Plugins are project-local. Two kinds:

**User-authored source files** — drop a `.mjs` file into the
appropriate directory and it auto-loads:

```
opensip-tools/
  fit/
    checks/      ← .mjs exporting `checks`  (auto-loaded)
    recipes/     ← .mjs exporting `recipes` (auto-loaded)
  sim/
    scenarios/   ← .mjs exporting `scenarios` (auto-loaded)
    recipes/     ← .mjs exporting `recipes`   (auto-loaded)
```

No config opt-in required. `opensip-tools init` scaffolds working
example files in each of these directories.

**npm-installed plugin packages** — explicit pinning in the config.
The pinned packages are installed under
`opensip-tools/.runtime/plugins/<domain>/node_modules/`:

```bash
opensip-tools plugin add @company/checks-custom    # installs + pins
opensip-tools plugin remove @company/checks-custom  # uninstalls + unpins
opensip-tools plugin list                           # what's installed
opensip-tools plugin sync                           # reinstall after a fresh clone
```

`plugin add` updates the `plugins.<domain>` list in
`opensip-tools.config.yml` so the install is reproducible across
machines. Marker-based discovery also runs for packages that declare
`opensipTools.kind`; transitive dependencies that lack an opensip-tools
marker do not auto-load.

```yaml
# opensip-tools.config.yml
plugins:
  fit:
    - "@company/checks-custom"
```

### Authoring a check package

Your check pack is an ordinary npm package that exports a `checks` and/or
`recipes` array. Declare `@opensip-tools/fitness` as a **peer dependency** —
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
    "@opensip-tools/fitness": "^2.8.0"
  },
  "devDependencies": {
    "@opensip-tools/fitness": "^2.8.0",
    "typescript": "^5.7.0"
  }
}
```

**`src/index.ts`**

```typescript
import { defineCheck, type Check, type CheckDisplayEntry } from '@opensip-tools/fitness';

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
`pnpm add @my-org/fitness-checks` (or `npm install`) in your project and the
CLI loads it on the next `fit` run.

For packages that do not declare the marker yet, list them by exact name in
your project's `opensip-tools.config.yml`:

```yaml
plugins:
  checkPackages:
    - "@my-org/fitness-checks"
```

This exact list supplements marker-based discovery.

**Why peer dependency?** Check packs return Check objects that the host
registers and executes; they don't mutate host singletons. Declaring
`@opensip-tools/fitness` as a peer means one copy of the fitness engine
serves every loaded pack, so peer resolution is clean and version
expectations are explicit. This mirrors the ESLint / Rollup plugin model.

### Single-file plugins

For quick local experiments, drop a `.mjs` file in
`opensip-tools/fit/checks/`:

```javascript
// opensip-tools/fit/checks/my-check.mjs
import { defineCheck } from '@opensip-tools/fitness';

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

`@opensip-tools/fitness` resolves from the global install (when the CLI
is installed via `npm install -g`) or from your project's
`node_modules` (when installed as a local devDependency). For pure
single-file plugins with no other npm setup, install the CLI globally
— that's the supported path.

### Recipes

Recipes are named check or scenario bundles — useful when you want to
run a specific set across multiple repos:

```javascript
// opensip-tools/fit/recipes/my-recipes.mjs
export const recipes = [{
  id: 'URCP_backend-strict',
  name: 'backend-strict',
  displayName: 'Backend Strict',
  description: 'All my checks plus opensip-tools backend checks',
  checks: { type: 'all', exclude: [] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

Then: `opensip-tools fit --recipe backend-strict`. Sim recipes work
the same way under `opensip-tools/sim/recipes/` and run via
`opensip-tools sim --recipe <name>`.

## CI Integration

### GitHub Actions

```yaml
- name: Run fitness checks
  run: npx opensip-tools fit --json > fitness-report.json

- name: Upload to OpenSIP
  run: npx opensip-tools fit --report-to ${{ secrets.OPENSIP_URL }} --api-key ${{ secrets.OPENSIP_KEY }}
```

### JSON Output

```json
{
  "schemaVersion": 2,
  "tool": "fit",
  "recipe": "default",
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
      "provider": "opensip-tools",
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
}
```

Every tool emits this `SignalEnvelope` shape on `--json`. The stable CI fields are `verdict.passed`, `verdict.score`, `verdict.summary`, `units[]`, and the flat `signals[]` list. See [JSON output schema](./docs/public/70-reference/04-json-output-schema.md) for the full field table and v1-to-v2 migration notes.

## Dashboard

Generate an HTML report with session history:

```bash
opensip-tools dashboard
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
opensip-tools sessions list                  # Show run history
opensip-tools sessions purge                 # Delete all sessions (prompts y/n)
opensip-tools sessions purge --older-than 7  # Delete sessions older than 7 days
opensip-tools sessions purge --yes           # Skip confirmation
```

## Updating & uninstalling

### Update

```bash
# Update to the latest release
npm install -g opensip-tools@latest        # or: pnpm add -g opensip-tools@latest

# Check the installed version
opensip-tools --version
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
opensip-tools uninstall --project                 # cwd
opensip-tools uninstall --project /path/to/repo   # explicit path

# 2. User-level config — cloud API key + per-user defaults
opensip-tools uninstall

# 3. The CLI binary itself
npm uninstall -g opensip-tools               # or: pnpm rm -g opensip-tools
```

The running binary can't safely self-delete, so step 3 is always a separate
`npm uninstall`. Steps 1 and 2 both support:

- `--dry-run` — print every target path and total size, take no action.
- `--yes` / `-y` — skip the `[y/N]` confirmation prompt (intended for scripts).

Project-mode uninstall removes only the rebuildable `.runtime/` state by
default. Your authored content (custom checks, recipes, scenarios) and
`opensip-tools.config.yml` are preserved.

To remove everything — including authored content and the config — pass
`--purge`. `--purge` is destructive: if your custom checks aren't committed
to git, you'll lose them. We recommend running `git status` first.

Both modes refuse to run when no opensip-tools state exists at the
resolved path, so an accidental `--project /unrelated/dir` is a no-op
rather than a destructive accident.

### Where state lives

| Path | Tracked by git? | Removed by default | Removed by `--purge` |
|---|---|---|---|
| `~/.opensip-tools/config.yml` | no — user-level | `opensip-tools uninstall` (user mode) | — |
| `<project>/opensip-tools.config.yml` | yes — project config | (kept) | `opensip-tools uninstall --project --purge` |
| `<project>/opensip-tools/.runtime/` | no — runtime state | `opensip-tools uninstall --project` | `opensip-tools uninstall --project --purge` |
| `<project>/opensip-tools/<user-content>/` (custom checks, recipes, scenarios) | yes — user-authored | (kept) | `opensip-tools uninstall --project --purge` |

## Observability

Every CLI invocation generates a `runId` (prefixed ULID — `RUN_<26char>`)
for log correlation. Structured JSON logs are written to
`<project>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl` (gitignored).
Sessions live in the project SQLite store at
`<project>/opensip-tools/.runtime/datastore.sqlite`. HTML reports are written to
`<project>/opensip-tools/.runtime/reports/latest.html`.

```bash
opensip-tools fit --debug    # Show structured log events on stderr
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
  core/                    # @opensip-tools/core — kernel: errors, logger, IDs,
                           #   language adapters, plugin loader, Registry/RunScope,
                           #   Tool contract
  contracts/               # @opensip-tools/contracts — contract types between
                           #   Tools and the runner: SignalEnvelope/CommandResult
                           #   shapes, exit codes, GraphCatalog surface
  datastore/               # @opensip-tools/datastore — SQLite + Drizzle persistence
  session-store/           # @opensip-tools/session-store — session persistence
  output/                  # @opensip-tools/output — SARIF / cloud report output
  dashboard/               # @opensip-tools/dashboard — self-contained HTML report
  cli-ui/                  # @opensip-tools/cli-ui — shared Ink/React primitives
  cli/                     # opensip-tools — generic tool dispatcher

  fitness/                 # @opensip-tools/fitness namespace
    engine/                # @opensip-tools/fitness — fit/list-checks/list-recipes/gate
                           #   commands, recipe service, gate, SARIF
    checks-typescript/     # @opensip-tools/checks-typescript — TS-AST checks
    checks-universal/      # @opensip-tools/checks-universal — text/regex/glob checks
    checks-python/         # @opensip-tools/checks-python — Python (no-bare-except)
    checks-go/             # @opensip-tools/checks-go — Go (no-fmt-print)
    checks-java/           # @opensip-tools/checks-java — Java (no-printstacktrace)
    checks-cpp/            # @opensip-tools/checks-cpp — C/C++ (clang-tidy)
    checks-rust/           # @opensip-tools/checks-rust — Rust (no-dbg-macro)

  graph/                   # @opensip-tools/graph namespace
    engine/                # @opensip-tools/graph — language-agnostic graph kernel
    graph-adapter-common/  # shared tree-sitter scaffolding (discover/parse/walk/
                           #   cache-key) for the go/java/python/rust adapters
    graph-typescript/      # TS call-graph adapter (TypeScript compiler API)
    graph-python/          # Python call-graph adapter (tree-sitter)
    graph-rust/            # Rust call-graph adapter (tree-sitter)
    graph-go/              # Go call-graph adapter (tree-sitter)
    graph-java/            # Java call-graph adapter (tree-sitter)

  simulation/              # @opensip-tools/simulation namespace
    engine/                # @opensip-tools/simulation — sim command + scenarios

  languages/               # language adapters (@opensip-tools/lang-*)
    lang-typescript/       # TypeScript / TSX adapter
    lang-rust/             # Rust adapter (hand-written lexer)
    lang-python/           # Python adapter
    lang-go/               # Go adapter
    lang-java/             # Java adapter
    lang-cpp/              # C/C++ adapter (command-mode via clang-tidy)
```

### Tool plugin architecture

The CLI is a generic dispatcher. Each invocation constructs a fresh
`ToolRegistry`, registers the first-party tools (fitness, graph, simulation)
into it, and walks it asking each registered Tool to mount its own
subcommands. Third-party tools are discovered automatically when their
`package.json` declares:

```json
{
  "opensipTools": { "kind": "tool" }
}
```

The `Tool` contract (`@opensip-tools/core/tools`) carries the tool's
metadata, command descriptors (for `--help` listings), and a `register(cli)`
method that mounts Commander commands. Tools call back into shared CLI
infrastructure (Ink rendering, dashboard auto-open, structured logging) via
the `ToolCliContext` they receive — they never depend on the CLI package
directly. This keeps the dependency graph acyclic and lets a third-party
tool ship without touching CLI source.

To author a new tool, see the source of `packages/fitness/engine/src/tool.ts`
or `packages/simulation/engine/src/tool.ts`. The shape is small enough to
keep the contract honest.

---

## About OpenSIP

opensip-tools is built and maintained by the team at [**OpenSIP**](https://opensip.ai). Visit **[opensip.ai](https://opensip.ai)** for OpenSIP itself — our hosted developer-productivity platform — and the rest of the product family.

This CLI is MIT-licensed and developed in the open at [github.com/opensip-ai/opensip-tools](https://github.com/opensip-ai/opensip-tools). Contributions welcome.

## License

MIT
