# Contributing to OpenSIP Tools

Thanks for your interest in contributing! This guide covers how to set up the project, write checks, and submit changes.

## Setup

```bash
git clone https://github.com/opensip-ai/opensip-tools.git
cd opensip-tools
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

Layered monorepo with three top-level groupings: top-level packages
(core, contracts, cli), per-tool namespaces (`packages/fitness/`,
`packages/simulation/`), and the language-adapter group (`packages/languages/`).

```
packages/
  core/                    # @opensip-tools/core — kernel
  contracts/              # @opensip-tools/contracts — shared CLI types/persistence
  cli/                     # @opensip-tools/cli — generic tool dispatcher

  fitness/
    engine/                # @opensip-tools/fitness — fitness engine + commands
    checks-typescript/     # TS-AST checks
    checks-universal/      # text/regex/glob checks
    checks-{python,go,java,cpp}/  # per-language packs

  simulation/
    engine/                # @opensip-tools/simulation

  languages/
    lang-{typescript,rust,python,go,java,cpp}/  # language adapters
```

See [CLAUDE.md](CLAUDE.md) for the full architecture overview, including
the layer rules enforced by dependency-cruiser.

## Writing a Fitness Check

Checks are defined with `defineCheck()` from `@opensip-tools/fitness`
(the fitness engine). Note: NOT `@opensip-tools/core` — core is the
kernel and doesn't carry fitness-domain symbols.

```typescript
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

export const myCheck = defineCheck({
  id: 'unique-uuid-here',       // Generate with: node -e "console.log(crypto.randomUUID())"
  slug: 'my-check-slug',        // Kebab-case, unique
  description: 'What this check does',
  scope: {
    languages: ['typescript'],   // Which file types to scan
    concerns: ['backend'],       // Which targets to match
  },
  tags: ['quality'],             // Used by recipes and --tags filter

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

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | UUID — unique identifier |
| `slug` | Yes | Kebab-case name (e.g., `no-console-log`) |
| `description` | Yes | One-line description |
| `scope` | Yes | `languages` and `concerns` for file targeting |
| `tags` | Yes | Array of tags for categorization |
| `analyze` | Yes* | Function that receives file content and returns violations |
| `analyzeAll` | Yes* | Alternative: receives a `FileAccessor` for cross-file analysis |
| `command` | Yes* | Alternative: runs an external tool (e.g., Semgrep) |
| `longDescription` | No | Detailed markdown description |
| `confidence` | No | `'high'`, `'medium'`, or `'low'` |
| `disabled` | No | Set `true` to disable by default |
| `itemType` | No | What the check validates: `'files'`, `'packages'`, `'modules'`, etc. |
| `timeout` | No | Timeout in ms (default: 30000) |

*One of `analyze`, `analyzeAll`, or `command` is required.

### Where to put checks

Pick the right pack based on what your check does:

| Check shape | Pack |
|-------------|------|
| Imports the TypeScript compiler API or parses TS/TSX AST | `packages/fitness/checks-typescript/` |
| Uses raw text / regex / file globs (language-agnostic) | `packages/fitness/checks-universal/` |
| Specific to Python source | `packages/fitness/checks-python/` |
| Specific to Go source | `packages/fitness/checks-go/` |
| Specific to Java source | `packages/fitness/checks-java/` |
| Specific to C/C++ source | `packages/fitness/checks-cpp/` |

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

**Source files (auto-loaded)** — drop a `.mjs` file in your project's
`opensip-tools/fit/checks/` (or `recipes/`) directory. The plugin
loader auto-discovers it on the next `opensip-tools fit` run; no
config opt-in required:

```javascript
// opensip-tools/fit/checks/my-check.mjs
import { defineCheck } from '@opensip-tools/fitness';

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

**npm packages (explicitly pinned)** — install via `opensip-tools
plugin add <package>`. The CLI runs `npm install` under
`opensip-tools/.runtime/plugins/fit/node_modules/` and adds the
package name to `plugins.fit:` in `opensip-tools.config.yml`. Only
packages listed there are loaded.

## Writing Tests

We use Vitest. Test files go next to the source as `*.test.ts` (or `*.test.tsx` for Ink components).

```bash
pnpm test                                    # All tests
pnpm --filter=@opensip-tools/core test       # Core tests only
pnpm --filter=@opensip-tools/cli test        # CLI tests only
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
- Structured logging via `logger` from `@opensip-tools/core`
- Imports follow ESLint's `import/order` (enforced): builtin → external →
  internal → parent → sibling → index, with newlines between groups
- Architecture-layer rules are enforced by dependency-cruiser. See
  [CLAUDE.md](CLAUDE.md) for the layer order. Adding a new edge that
  violates the rules will fail CI; refactor or surface for discussion.

## Reporting Issues

Open an issue at https://github.com/opensip-ai/opensip-tools/issues with:
- What you expected
- What happened
- Steps to reproduce
- Node.js version and OS
