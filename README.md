# OpenSIP Tools

Open-source codebase analysis toolkit. Run fitness checks against TypeScript, Rust, Python, Java, Go, or C/C++ codebases standalone, in CI, or as a regression detector around AI-agent coding sessions. Integrates with [OpenSIP Cloud](https://opensip.ai) for centralized reporting.

opensip-tools is a **collection of tools**, not a single tool. Today it ships
with two: `fit` (fitness checks) and `sim` (simulation scenarios, experimental).
Adding a new tool is a plugin operation — install a package that implements the
[Tool contract](#tool-plugin-architecture) and the CLI picks it up automatically.

## Installation

```bash
npm install -g @opensip-tools/cli
```

Then from any project root:

```bash
opensip-tools fit     # run fitness checks (your first scan)
opensip-tools sim     # run simulations [experimental]
```

That's the whole setup. `fit` and `sim` are the two primary subcommands; everything else is options and plumbing.

No global install? Use `npx @opensip-tools/cli fit` for one-offs, or install from source:

```bash
git clone https://github.com/opensip-ai/opensip-tools.git
cd opensip-tools && pnpm install && pnpm build
node packages/cli/dist/index.js fit
```

## First run

```bash
cd your-project
opensip-tools fit                 # runs the default recipe (all enabled checks)
opensip-tools fit --findings      # + detailed per-violation output
opensip-tools fit --list          # browse the check catalog
```

If `opensip-tools fit` reports zero checks ran, you likely need a targets file — create one with `opensip-tools init` (see [Configuration](#configuration)).

## Commands

### `fit` — fitness checks
```bash
opensip-tools fit                   # run all checks (default recipe)
opensip-tools fit --recipe <name>   # use a named recipe (e.g. quick-smoke, backend)
opensip-tools fit --check <slug>    # run a single check
opensip-tools fit --tags <tags>     # filter by tag (comma-separated)
opensip-tools fit --findings        # show per-violation detail
opensip-tools fit --verbose         # full results table
opensip-tools fit --json            # structured JSON (for CI)
opensip-tools fit --list            # list available checks
opensip-tools fit --recipes         # list available recipes
opensip-tools fit --gate-save       # save current findings as architecture baseline
opensip-tools fit --gate-compare    # compare against baseline; exit 1 on regression
```

### Project setup & dashboards
```bash
opensip-tools init                  # generate opensip-tools.config.yml
opensip-tools configure             # set up OpenSIP Cloud API key (interactive)
opensip-tools dashboard             # HTML report — opens in browser
opensip-tools sessions list         # run history
opensip-tools sessions purge        # delete session data (prompts for confirm)
```

### Plugins
```bash
opensip-tools plugin list           # installed plugins
opensip-tools plugin install <pkg>  # install a plugin package or local path
opensip-tools plugin remove  <pkg>  # remove
```

### `sim` — simulations *(experimental)*
```bash
opensip-tools sim                   # run simulations
```

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

Use `--verbose` for the full results table, or `--findings` for detailed violation output.

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
| `pre-commit` | Fast checks for git hooks |
| `ci` | Optimized for CI pipelines |
| `architecture` | Architecture validation |

### Check Tags

Checks are organized by tags: `security`, `quality`, `architecture`, `modularity`, `testing`, `resilience`, `observability`, `accessibility`, and more. Use `--tags` to filter or `--list` to browse all checks.

## Configuration

Generate a config file with `opensip-tools init`:

```yaml
# opensip-tools.config.yml

globalExcludes:
  - "docs/**"

targets:
  backend:
    description: Backend source code
    languages: [typescript]
    concerns: [backend, server, api]
    include:
      - "src/**/*.ts"
    exclude:
      - "**/*.test.ts"
      - "**/node_modules/**"

fitness:
  failOnErrors: 1      # Exit code 1 if errors >= this (default: 1)
  failOnWarnings: 0    # Exit code 1 if warnings >= this (default: 0, warnings don't fail)
  disabledChecks: []
```

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

**Default baseline location** is `<cwd>/.opensip-tools/baseline.sarif`. Use `--baseline <path>` to override. Add `.opensip-tools/` to `.gitignore` — baselines are repo-state snapshots, not source.

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

Plugins live in `~/.opensip-tools/fit/` (checks) and `~/.opensip-tools/sim/` (simulation scenarios). They can be npm packages or single `.mjs` files and can contribute **checks** and **recipes**.

```bash
# Install an npm-published plugin
opensip-tools plugin install @company/checks-custom

# Install a local plugin under development
opensip-tools plugin install /abs/path/to/my-plugin

# List installed plugins
opensip-tools plugin list

# Remove a plugin
opensip-tools plugin remove @company/checks-custom
```

`plugin install` runs `npm install` under the hood in `~/.opensip-tools/fit/` and also installs any `peerDependencies` the plugin declares (see below).

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
    "@opensip-tools/fitness": "^2.0.0"
  },
  "devDependencies": {
    "@opensip-tools/fitness": "^2.0.0",
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

#### Auto-discovery

Any installed npm package whose name matches `@opensip-tools/checks-*` is
auto-discovered by the CLI — no `plugin install` step needed. Run
`pnpm add @my-org/fitness-checks` (or `npm install`) in your project, name
the package's bin or use the explicit list option, and the CLI loads it on
the next `fit` run.

For non-`@opensip-tools/checks-*` names, declare them in your project's
`opensip-tools.config.yml`:

```yaml
plugins:
  checkPackages:
    - "@my-org/fitness-checks"
```

This explicit list disables auto-discovery for the run, so you get a
deterministic set of check packs.

**Why peer dependency?** Check packs return Check objects that the host
registers and executes; they don't mutate host singletons. Declaring
`@opensip-tools/fitness` as a peer means one copy of the fitness engine
serves every loaded pack, so peer resolution is clean and version
expectations are explicit. This mirrors the ESLint / Rollup plugin model.

### Single-file plugins

For quick local experiments, drop a `.js` or `.mjs` file directly in `~/.opensip-tools/fit/`:

```javascript
// ~/.opensip-tools/fit/my-check.mjs
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

Single-file plugins resolve `@opensip-tools/fitness` from whatever copy is already sitting in `~/.opensip-tools/fit/node_modules/` (installed by any prior `plugin install`). If no package plugins are installed, run `opensip-tools plugin install @opensip-tools/fitness` once to seed it.

### Recipes in plugins

Recipes are named check bundles — useful when you want to run a specific set of checks across multiple repos:

```javascript
// ~/.opensip-tools/fit/my-recipes.mjs
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

Then: `opensip-tools fit --recipe backend-strict`.

## Cloud Integration

Send findings to OpenSIP Cloud as SARIF:

```bash
# One-time setup (interactive prompt for your API key)
opensip-tools configure

# Then send findings
opensip-tools fit --report-to https://your-opensip-instance/api/ingest

# Or pass the key per-invocation
opensip-tools fit --report-to https://your-opensip-instance/api/ingest --api-key sk-...
```

Findings are posted in SARIF 2.1.0 format with automatic retry on network failures.

API key resolution: `--api-key` flag > `OPENSIP_API_KEY` env var > `~/.opensip-tools/config.yml`.

## CI Integration

### GitHub Actions

```yaml
- name: Run fitness checks
  run: npx @opensip-tools/cli fit --json > fitness-report.json

- name: Upload to OpenSIP
  run: npx @opensip-tools/cli fit --report-to ${{ secrets.OPENSIP_URL }} --api-key ${{ secrets.OPENSIP_KEY }}
```

### JSON Output

```json
{
  "version": "1.0",
  "tool": "fit",
  "timestamp": "2026-04-02T18:00:00.000Z",
  "recipe": "default",
  "score": 92,
  "passed": true,
  "summary": {
    "total": 124,
    "passed": 120,
    "failed": 4,
    "errors": 12,
    "warnings": 45
  },
  "checks": [
    {
      "checkSlug": "no-console-log",
      "passed": false,
      "findings": [
        {
          "ruleId": "no-console-log",
          "message": "console.log found in production code",
          "severity": "error",
          "filePath": "src/utils.ts",
          "line": 42
        }
      ],
      "durationMs": 150
    }
  ],
  "durationMs": 8100
}
```

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

## Session Management

```bash
opensip-tools sessions list                  # Show run history
opensip-tools sessions purge                 # Delete all sessions (prompts y/n)
opensip-tools sessions purge --older-than 7  # Delete sessions older than 7 days
opensip-tools sessions purge --yes           # Skip confirmation
```

## Observability

Every CLI invocation generates a `runId` (ULID) for log correlation. Structured JSON logs are written to `~/.opensip-tools/logs/`.

```bash
opensip-tools fit --debug    # Show structured log events on stderr
```

Log files rotate daily, keeping the last 7 days.

## Architecture

Turborepo + pnpm monorepo. Layered: lower numbers depend only on
higher numbers, never the other direction. Architecture rules are
enforced in CI by [dependency-cruiser](https://github.com/sverweij/dependency-cruiser).

```
packages/
  core/                    # @opensip-tools/core — kernel: errors, logger, IDs,
                           #   language adapters, plugin loader, Tool contract
  cli-shared/              # @opensip-tools/cli-shared — CLI types, exit codes,
                           #   session persistence, dashboard HTML generator
  cli/                     # @opensip-tools/cli — generic tool dispatcher (Ink/React)

  fitness/                 # @opensip-tools/fitness namespace
    engine/                # @opensip-tools/fitness — fit/dashboard/list-checks
                           #   commands, recipe service, gate, SARIF reporting
    checks-typescript/     # @opensip-tools/checks-typescript — TS-AST checks
    checks-universal/      # @opensip-tools/checks-universal — text/regex/glob checks
    checks-python/         # @opensip-tools/checks-python — Python (no-bare-except)
    checks-go/             # @opensip-tools/checks-go — Go (no-fmt-print)
    checks-java/           # @opensip-tools/checks-java — Java (no-printstacktrace)
    checks-cpp/            # @opensip-tools/checks-cpp — C/C++ (clang-tidy)

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

The CLI is a generic dispatcher that walks `defaultToolRegistry` and asks
each registered Tool to mount its own subcommands. fitness and simulation
are first-party tools; third-party tools are discovered automatically when
their `package.json` declares:

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

## License

MIT
