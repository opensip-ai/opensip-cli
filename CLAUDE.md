# CLAUDE.md - AI Agent Guidance for OpenSIP Tools

This is the **START HERE** document for AI agents working on the OpenSIP Tools codebase.

## What is OpenSIP Tools?

OpenSIP Tools is an **open-source codebase analysis toolkit** — a CLI that
hosts pluggable tools for static analysis. Today it ships with two: `fit`
(fitness checks across TypeScript, Rust, Python, Java, Go, C/C++) and `sim`
(simulation scenarios, experimental). Adding a new tool is a plugin
operation; the CLI is a generic dispatcher.

## Repository Structure

Turborepo + pnpm monorepo. Workspace scope: `@opensip-tools/*`. Layered —
lower depends on higher only; never the other direction. Architecture
rules are enforced by dependency-cruiser in CI.

```
opensip-tools/
├── packages/
│   ├── core/                    # @opensip-tools/core — kernel: errors, logger,
│   │                            #   IDs, language adapters, plugin loader,
│   │                            #   Tool contract
│   ├── contracts/               # @opensip-tools/contracts — contract types
│   │                            #   between Tools and the runner: CliOutput,
│   │                            #   CommandResult, exit codes, session
│   │                            #   persistence, dashboard HTML generator
│   ├── cli/                     # @opensip-tools/cli — generic tool dispatcher
│   │
│   ├── fitness/                 # fitness namespace
│   │   ├── engine/              # @opensip-tools/fitness — fitness engine,
│   │   │                        #   fit/dashboard/list-checks/list-recipes,
│   │   │                        #   gate, SARIF
│   │   ├── checks-typescript/   # @opensip-tools/checks-typescript (66 checks)
│   │   ├── checks-universal/    # @opensip-tools/checks-universal (92 checks)
│   │   ├── checks-python/       # @opensip-tools/checks-python
│   │   ├── checks-go/           # @opensip-tools/checks-go
│   │   ├── checks-java/         # @opensip-tools/checks-java
│   │   └── checks-cpp/          # @opensip-tools/checks-cpp
│   │
│   ├── simulation/              # simulation namespace
│   │   └── engine/              # @opensip-tools/simulation
│   │
│   └── languages/               # language adapters
│       ├── lang-typescript/
│       ├── lang-rust/
│       ├── lang-python/
│       ├── lang-go/
│       ├── lang-java/
│       └── lang-cpp/
│
├── eslint.config.mjs            # workspace ESLint config
├── knip.json                    # knip orphan-detection config
├── .dependency-cruiser.cjs      # architecture-layer enforcement
├── turbo.json                   # Turborepo task config
├── pnpm-workspace.yaml          # packages/*  +  packages/<tool>/*
└── tsconfig.json                # Root TS config (ES2022, Node16)
```

## Tech Stack

| Layer    | Stack                                               |
| -------- | --------------------------------------------------- |
| Runtime  | Node.js 22+, TypeScript 5.7+                        |
| Build    | Turborepo, pnpm 10+ workspaces                      |
| CLI UI   | Ink (React for terminals), Commander.js             |
| Quality  | ESLint flat config (sonarjs/unicorn/import),        |
|          | dependency-cruiser, knip                            |
| Testing  | Vitest                                              |

## Essential Commands

```bash
# Setup
pnpm install && pnpm build

# Run fitness checks against this repo (must build first)
pnpm fit            # shortcut for: node packages/cli/dist/index.js fit

# Run all tests
pnpm test

# Typecheck
pnpm typecheck

# Lint (ESLint + dependency-cruiser; both must be 0-error)
pnpm lint
pnpm lint:fix       # ESLint auto-fix only

# Per-package
pnpm --filter=@opensip-tools/<pkg> build
pnpm --filter=@opensip-tools/<pkg> test
```

## CLI Architecture

The `opensip-tools` binary (`packages/cli/src/index.ts`) is a generic
tool dispatcher:

1. Registers bundled language adapters (TypeScript, Rust, Python, Java,
   Go, C/C++) into the kernel's `defaultLanguageRegistry`.
2. Registers first-party tools — `fitnessTool` and `simulationTool` —
   into `defaultToolRegistry`.
3. Discovers third-party tools via `discoverToolPackages()` (any npm
   package whose `package.json` declares `opensipTools.kind === 'tool'`).
4. Walks the tool registry; each tool's `register(cli)` method mounts
   its Commander subcommands using shared CLI infrastructure
   (`ToolCliContext`).
5. Adds CLI-only commands: `init`, `sessions`, `configure`, `plugin`,
   `completion`, `uninstall`.

**The CLI source has zero direct imports from `@opensip-tools/fitness` or
`@opensip-tools/simulation`** beyond the static `tool` exports.

Subcommands available out of the box:

- `opensip-tools fit` — Run fitness checks (with --gate-save, --gate-compare,
  --recipe, --check, --tags, --json, --report-to)
- `opensip-tools fit-list` (alias `list-checks`) — List available checks
- `opensip-tools fit-recipes` (alias `list-recipes`) — List available recipes
- `opensip-tools dashboard` — Generate HTML report
- `opensip-tools sim` — Run simulation scenarios [experimental]
- `opensip-tools init` — Generate `opensip-tools.config.yml`
- `opensip-tools sessions list|purge` — Manage stored sessions
- `opensip-tools plugin list|add|remove|sync` — Manage plugins
- `opensip-tools configure` — Set up OpenSIP Cloud API key

## Fitness Check System

158+ checks across 6 language packs and 2 cross-cutting packs:

- `@opensip-tools/checks-typescript` (66 checks) — TS-AST-driven checks
  (drizzle-orm, typed-inject, react, package.json exports, tsconfig).
- `@opensip-tools/checks-universal` (92 checks) — text/regex/glob checks
  (Docker, .env, Sentry, generic structure, dead-code via knip).
- `@opensip-tools/checks-python|go|java|cpp` — language-specific checks.

### Key Files

- `packages/fitness/engine/src/framework/define-check.ts` — `defineCheck()` API
- `packages/fitness/engine/src/framework/registry.ts` — `defaultRegistry`
- `packages/fitness/engine/src/recipes/` — Recipe service, registry, types
- `packages/fitness/engine/src/cli/` — fit/dashboard/list-checks/list-recipes
  command implementations
- `packages/fitness/engine/src/tool.ts` — fitness's Tool plugin descriptor

Adding a new check:
1. Decide which pack it belongs in (TS-AST → checks-typescript;
   text/regex → checks-universal; language-specific → checks-<lang>).
2. Add the source file under `src/checks/<category>/`.
3. Re-export it from the pack's `src/index.ts` barrel.
4. Add a display entry to `src/display/<category>.ts` if you want a
   pretty name and icon (otherwise kebab-to-title-case fallback applies).

### Defining a Check

Checks declare **scope** (languages + concerns) for file targeting. The
platform matches checks to targets defined in `opensip-tools.config.yml`
via set intersection.

```typescript
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

export const myCheck = defineCheck({
  id: 'uuid-here',
  slug: 'my-check-slug',
  description: 'What this check does',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  tags: ['quality'],
  analyze: (content, filePath) => {
    const violations: CheckViolation[] = [];
    // ... detect issues
    return violations;
  },
});
```

`defineCheck` lives in `@opensip-tools/fitness`, NOT `@opensip-tools/core`.
Core is a strict kernel — language adapters, plugin loader, errors,
logger, IDs, retry, the Tool contract. Anything fitness-shaped lives in
fitness.

### File Scoping (Two-Layer Model)

- **Checks** declare intent: `scope: { languages: ['typescript'], concerns: ['backend'] }`
- **Targets** (`opensip-tools.config.yml`) declare reality: named file sets
  with `languages`, `concerns`, and include/exclude globs
- **Resolution**: `checkOverrides > scope matching > file cache fallback`
- **Global excludes**: `globalExcludes` in `opensip-tools.config.yml` —
  applied to BOTH scope-matched and fileCache-fallback paths (D14)
- **Per-check exemptions**: `@fitness-ignore-file <check-slug>` inline directives

## Coding Standards

### Testing

Vitest. Test files: `*.test.ts` next to the source. Run with `pnpm test`
or `pnpm --filter=@opensip-tools/<pkg> test`.

### Imports

- **Workspace packages** — `import { x } from '@opensip-tools/<pkg>'`
- **Subpath exports** are strongly discouraged; prefer the package
  barrel. The exception is
  `@opensip-tools/core/languages/parse-cache.js` (used by language
  adapters).
- **Internal** — relative paths within a package, always with `.js`
  extension (ESM Node16 module resolution requires it).
- **Type-only imports** — `import type { X }` whenever possible. The
  `@typescript-eslint/consistent-type-imports` rule enforces inline
  `type` for mixed value+type imports.

### Layering rules (enforced by dependency-cruiser)

```
core (kernel)
  ↑
contracts (Tool↔runner contract types)
  ↑
lang-* / fitness / simulation (peer layer)
  ↑
checks-* (depend on fitness)
  ↑
cli (entry point — depends on every tool)
```

- core must NOT import from contracts, cli, fitness, simulation, lang-*, or checks-*.
- contracts must NOT import from cli, fitness, simulation, lang-*, or checks-*.
- fitness / simulation must NOT import from cli (would create a cycle).
- check packs must NOT import from cli or contracts.
- lang-* packs must NOT import from cli, contracts, fitness, simulation, or
  each other. (The historical lang-typescript exception for `filterContent`
  was paid down — the symbol now lives in `@opensip-tools/lang-typescript`
  alongside the rest of the TS-aware string/comment stripping.)

If you need to violate a rule, the right move is usually to refactor the
shared piece into core. If that's wrong, surface it for discussion before
disabling the rule.

## Before Committing

```bash
pnpm typecheck && pnpm test && pnpm lint
```

`pnpm lint` runs both ESLint and dependency-cruiser. Both must be 0-error.

## Release Process

Releases are tag-driven. See `RELEASING.md` — there are 17 packages
to publish, in a specific dependency order, via OIDC trusted publishing.

The release workflow has two non-obvious steps (npm 11 to a separate
prefix; `pnpm pack` + `npm publish <tarball>`) that look like they
could be simplified but cannot — both work around concrete bugs in
npm's self-replacement and pnpm's lack of OIDC support.

## Project Status

**v1.0.0** — first stable release. opensip-tools is a tool-plugin
platform: `core` is a strict kernel, `fitness` and `simulation` are
peer tools implementing a shared Tool contract, and `cli` is a
generic dispatcher. Adding a new tool requires zero CLI changes.

The new-customer flow is three commands: `init` (language detection
+ scaffolded layout) → `fit --recipe example` → `sim --recipe
example`. Project layout is local: user-authored content under
`<project>/opensip-tools/{fit,sim}/{checks,recipes,scenarios}/`
(tracked) and tool-generated state under
`<project>/opensip-tools/.runtime/` (gitignored). Plugin loader
auto-discovers `.mjs` files by directory presence; npm packages
must be explicitly listed in `plugins.<domain>` to load.

Future tool ideas (not implemented): `audit`, `lint`, `bench`. Any of
these would slot in by writing a Tool implementation and shipping a
package.
