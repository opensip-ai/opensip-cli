# OpenSIP Tools

Open-source codebase analysis toolkit. Run fitness checks against any TypeScript/JavaScript codebase — standalone in the CLI, in CI pipelines, or integrated with [OpenSIP Cloud](https://opensip.ai) for centralized reporting.

## Installation

### npm (recommended)

```bash
npm install -g @opensip-tools/cli

cd your-project
opensip-tools fit
```

### npx (no install)

```bash
npx @opensip-tools/cli fit
```

### From source

```bash
git clone https://github.com/opensip-ai/opensip-tools.git
cd opensip-tools
pnpm install && pnpm build
node packages/cli/dist/index.js fit
```

## Commands

```bash
opensip-tools fit              # Run fitness checks
opensip-tools fit --verbose    # Show detailed results table
opensip-tools fit --findings   # Show table + per-check violation details
opensip-tools fit --json       # Structured JSON output (for CI)
opensip-tools fit --list       # List all available checks
opensip-tools fit --recipes    # List available recipes

opensip-tools init             # Generate opensip-tools.config.yml
opensip-tools dashboard        # Generate HTML report and open in browser
opensip-tools sessions list    # Show stored session history
opensip-tools sessions purge   # Delete session data (with confirmation)
opensip-tools plugin list      # List installed plugins
opensip-tools sim              # Run simulations [experimental]
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

Checks are organized by tags: `security`, `quality`, `architecture`, `testing`, `resilience`, `observability`, `accessibility`, and more. Use `--tags` to filter or `--list` to browse all checks.

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

### Authoring a plugin package

Your plugin is an ordinary npm package that exports a `checks` and/or `recipes` array. Declare `@opensip-tools/core` as a **peer dependency**, not a regular dependency — this lets the host and your plugin share one Check/Signal shape and avoids version drift.

**`package.json`**

```json
{
  "name": "@my-org/fitness-checks",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": {
    "@opensip-tools/core": "^0.1.0"
  },
  "devDependencies": {
    "@opensip-tools/core": "^0.1.0",
    "typescript": "^5.7.0"
  }
}
```

**`src/index.ts`**

```typescript
import { defineCheck, type Check } from '@opensip-tools/core';

const myCheck: Check = defineCheck({
  id: '3f7a…-uuid',
  slug: 'my-custom-check',
  category: 'quality',
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

Publish to npm (or install from a local path) and users can `opensip-tools plugin install @my-org/fitness-checks`.

**Why peer dependency?** Plugins return Check objects that the host registers and executes; they don't mutate host singletons. Declaring `@opensip-tools/core` as a peer means one copy lives in the plugin directory alongside all plugins that need it, so peer resolution is clean and version expectations are explicit. This is the same pattern ESLint and Rollup use.

### Single-file plugins

For quick local experiments, drop a `.js` or `.mjs` file directly in `~/.opensip-tools/fit/`:

```javascript
// ~/.opensip-tools/fit/my-check.mjs
import { defineCheck } from '@opensip-tools/core';

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

Single-file plugins resolve `@opensip-tools/core` from whatever copy is already sitting in `~/.opensip-tools/fit/node_modules/` (installed by any prior `plugin install`). If no package plugins are installed, run `opensip-tools plugin install @opensip-tools/core` once to seed it.

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
opensip-tools fit --report-to https://your-opensip-instance/api/ingest --api-key sk-...
```

Findings are posted in SARIF 2.1.0 format with automatic retry on network failures.

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

Turborepo + pnpm monorepo:

```
packages/
  cli/             # @opensip-tools/cli — CLI binary (Ink/React)
  core/            # @opensip-tools/core — Framework, registry, recipes
  checks-builtin/  # @opensip-tools/checks-builtin — Built-in fitness checks
  simulation/      # @opensip-tools/simulation — Simulation engine [experimental]
```

## License

MIT
