# Contributing to OpenSIP CLI

Thanks for your interest in contributing! This guide covers how to set up the project, write checks, and submit changes.

## Setup

```bash
git clone https://github.com/opensip-ai/opensip-cli.git
cd opensip-cli
pnpm install
pnpm build
```

### Verify your setup

```bash
pnpm typecheck    # TypeScript compilation
pnpm test         # Run all tests
pnpm fit          # Run fitness checks against this repo
```

## Project Structure

Layered pnpm/Turborepo monorepo with a strict kernel, host packages, tool
packages, language adapters, graph adapters, and first-party check packs.

```
packages/
  core/                    # @opensip-cli/core — kernel
  contracts/               # @opensip-cli/contracts — Tool↔runner contract types
  cli/                     # opensip-cli — generic tool dispatcher
  config/                  # @opensip-cli/config — config composer
  datastore/               # @opensip-cli/datastore — SQLite + Drizzle
  output/                  # @opensip-cli/output — JSON/SARIF/signal delivery
  session-store/           # @opensip-cli/session-store — run history
  targeting/               # @opensip-cli/targeting — file-target substrate
  cli-ui/                  # @opensip-cli/cli-ui — shared terminal UI
  dashboard/               # @opensip-cli/dashboard — HTML report generator
  tree-sitter/             # @opensip-cli/tree-sitter — WASM parser substrate

  fitness/
    engine/                # @opensip-cli/fitness — fitness engine + commands
    checks-typescript/     # TS-AST checks
    checks-universal/      # text/regex/glob checks
    checks-{python,go,java,cpp,rust}/  # per-language packs

  simulation/
    engine/                # @opensip-cli/simulation

  graph/
    engine/                # @opensip-cli/graph
    graph-adapter-common/  # shared graph adapter scaffolding
    graph-{typescript,python,rust,go,java}/

  languages/
    lang-{typescript,rust,python,go,java,cpp}/  # language adapters
```

See [CLAUDE.md](CLAUDE.md) for the full architecture overview, including
the layer rules enforced by dependency-cruiser.

## Writing a Fitness Check

Checks are defined with `defineCheck()` from `@opensip-cli/fitness`
(the fitness engine). Note: NOT `@opensip-cli/core` — core is the
kernel and doesn't carry fitness-domain symbols.

```typescript
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

export const myCheck = defineCheck({
  id: 'unique-uuid-here', // Generate with: node -e "console.log(crypto.randomUUID())"
  slug: 'my-check-slug', // Kebab-case, unique
  description: 'What this check does',
  scope: {
    languages: ['typescript'], // Which file types to scan
    concerns: ['backend'], // Which targets to match
  },
  tags: ['quality'], // Used by recipes and --tags filter

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = [];

    // Your detection logic here
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({
          line: i + 1,
          message: 'Found a TODO comment',
          severity: 'warning',
          suggestion: 'Resolve or create a ticket for this TODO',
          filePath,
        });
      }
    }

    return violations;
  },
});
```

### Check fields

| Field             | Required | Description                                                          |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `id`              | Yes      | UUID — unique identifier                                             |
| `slug`            | Yes      | Kebab-case name (e.g., `no-console-log`)                             |
| `description`     | Yes      | One-line description                                                 |
| `scope`           | Yes      | `languages` and `concerns` for file targeting                        |
| `tags`            | Yes      | Array of tags for categorization                                     |
| `analyze`         | Yes\*    | Function that receives file content and returns violations           |
| `analyzeAll`      | Yes\*    | Alternative: receives a `FileAccessor` for cross-file analysis       |
| `command`         | Yes\*    | Alternative: runs an external tool (e.g., Semgrep)                   |
| `longDescription` | No       | Detailed markdown description                                        |
| `confidence`      | No       | `'high'`, `'medium'`, or `'low'`                                     |
| `disabled`        | No       | Set `true` to disable by default                                     |
| `itemType`        | No       | What the check validates: `'files'`, `'packages'`, `'modules'`, etc. |
| `timeout`         | No       | Timeout in ms (default: 30000)                                       |

\*One of `analyze`, `analyzeAll`, or `command` is required.

### Where to put checks

Pick the right pack based on what your check does:

| Check shape                                              | Pack                                  |
| -------------------------------------------------------- | ------------------------------------- |
| Imports the TypeScript compiler API or parses TS/TSX AST | `packages/fitness/checks-typescript/` |
| Uses raw text / regex / file globs (language-agnostic)   | `packages/fitness/checks-universal/`  |
| Specific to Python source                                | `packages/fitness/checks-python/`     |
| Specific to Go source                                    | `packages/fitness/checks-go/`         |
| Specific to Java source                                  | `packages/fitness/checks-java/`       |
| Specific to C/C++ source                                 | `packages/fitness/checks-cpp/`        |
| Specific to Rust source                                  | `packages/fitness/checks-rust/`       |

Within a pack, checks live under `src/checks/<category>/`:

- `architecture/` — structural patterns
- `quality/` — code quality and style
- `resilience/` — error handling and robustness
- `security/` — security vulnerabilities
- `testing/` — test quality
- `documentation/` — docs and comments

After creating a check file:

1. Export the check from the category's `index.ts` barrel file
2. Add a display entry in the pack's `src/display/` (icon + human-readable name)
3. Run `pnpm test` to verify the pack still loads and the new check
   passes the contract test (slug uniqueness, ID format, etc.)

### Custom checks (plugin)

For checks that aren't suitable for the built-in set, you have two
project-local options:

**Source files (auto-loaded)** — drop a `.js` or `.mjs` file anywhere under
your project's `opensip-cli/fit/checks/` (or `recipes/`) directory. The plugin
loader auto-discovers files recursively on the next `opensip fit` run; no config
opt-in required:

```javascript
// opensip-cli/fit/checks/my-check.mjs
import { defineCheck } from '@opensip-cli/fitness';

export const checks = [
  defineCheck({
    id: 'unique-uuid-here',
    slug: 'my-check',
    description: 'What this check does',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['custom'],
    analyze: (content, filePath) => [],
  }),
];
```

**npm packages (explicitly pinned)** — install fit/sim packs via
`opensip plugin add <package>`. The CLI runs `npm install` under
`opensip-cli/.runtime/plugins/<domain>/node_modules/` and adds the package name
to `plugins.<domain>:` in `opensip-cli.config.yml`. Only packages listed there
are loaded. Whole Tool plugins are managed with `opensip tools ...` (or
`opensip plugin add --domain tool` for the compatibility path).

## Writing Tests

We use Vitest. Test files go next to the source as `*.test.ts` (or `*.test.tsx` for Ink components).

```bash
pnpm test                                    # All tests
pnpm --filter=@opensip-cli/core test       # Core tests only
pnpm --filter=opensip-cli test        # CLI tests only
```

### Testing Ink components

```typescript
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../ui/theme.js';
import { MyComponent } from '../ui/components/MyComponent.js';

it('renders correctly', () => {
  const { lastFrame } = render(
    <ThemeProvider>
      <MyComponent prop="value" />
    </ThemeProvider>,
  );
  expect(lastFrame()).toContain('expected text');
});
```

## Before Submitting a PR

```bash
pnpm build       # Must pass
pnpm typecheck   # Must pass
pnpm test        # Must pass
pnpm lint        # ESLint + dependency-cruiser; both must be 0-error
```

## Code Style

- TypeScript strict mode
- ESM (`"type": "module"`) — use `.js` extensions in imports
- Ink components use `.tsx` extension
- No hardcoded colors in UI — use `useTheme()` from `ui/theme.ts`
- Commands return data objects — rendering is the UI layer's job
- Structured logging via `logger` from `@opensip-cli/core`
- Imports follow ESLint's `import/order` (enforced): builtin → external →
  internal → parent → sibling → index, with newlines between groups
- Architecture-layer rules are enforced by dependency-cruiser. See
  [CLAUDE.md](CLAUDE.md) for the layer order. Adding a new edge that
  violates the rules will fail CI; refactor or surface for discussion.

## Reporting Issues

Open an issue at https://github.com/opensip-ai/opensip-cli/issues with:

- What you expected
- What happened
- Steps to reproduce
- Node.js version and OS
