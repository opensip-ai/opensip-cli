# CLAUDE.md - AI Agent Guidance for OpenSIP Tools

This is the **START HERE** document for AI agents working on the OpenSIP Tools codebase.

## What is OpenSIP Tools?

OpenSIP Tools is an **open-source codebase analysis toolkit** extracted from the larger OpenSIP platform. It provides fitness checks (static analysis) and simulation scenarios as a standalone CLI tool.

## Repository Structure

Turborepo + pnpm monorepo. Workspace scope: `@opensip-tools/*`.

```
opensip-tools/
├── packages/
│   ├── cli/              # @opensip-tools/cli — CLI binary (opensip-tools command)
│   ├── core/             # @opensip-tools/core — Framework: check definition, registry, scope resolution, AST utilities
│   ├── fitness/          # @opensip-tools/fitness — 215+ fitness checks across all categories
│   ├── simulation/       # @opensip-tools/simulation — Simulation engine + scenarios
├── turbo.json            # Turborepo task config
├── pnpm-workspace.yaml   # Workspace: packages/*
└── tsconfig.json         # Root TypeScript config (ES2022, Node16)
```

## Tech Stack

| Layer    | Stack                           |
| -------- | ------------------------------- |
| Runtime  | Node.js 22+, TypeScript 5.7+   |
| Build    | Turborepo, pnpm 10+ workspaces |
| Testing  | Vitest                          |

## Essential Commands

```bash
# Setup
pnpm install && pnpm build

# Run fitness checks (must build first)
pnpm fit            # shortcut for: node packages/cli/dist/index.js fit

# Run all tests
pnpm test

# Typecheck
pnpm typecheck

# Per-package
pnpm --filter=@opensip-tools/<pkg> build
pnpm --filter=@opensip-tools/<pkg> test
```

## CLI Architecture

The `opensip-tools` binary (`packages/cli/src/index.ts`) is the entry point:

- **`opensip-tools fit`** — Run fitness checks (batch progress, table output, summary)
- **`opensip-tools fit --list`** — List available checks
- **`opensip-tools fit --recipes`** — List available recipes
- **`opensip-tools sim`** — Run simulation scenarios [experimental]

The CLI is registered as a bin in `packages/cli/package.json` and must be run via `pnpm --filter @opensip-tools/cli exec opensip-tools` or after global linking.

## Fitness Check System

215+ checks across categories: architecture, quality, security, resilience, testing, documentation.

### Key Files

- `packages/fitness/src/register-checks.ts` — Auto-registers all checks with defaultRegistry
- `packages/core/src/framework/define-check.ts` — `defineCheck()` API
- `packages/core/src/framework/registry.ts` — Check registry (defaultRegistry)
- `packages/fitness/src/checks/` — All check implementations (one file per check)
- `packages/fitness/src/display/` — Check display names and icons

### Defining a Check

Checks declare **scope** (languages + concerns) for file targeting. The platform matches checks to targets defined in `opensip-tools.config.yml` via set intersection.

```typescript
export const myCheck = defineCheck({
  id: 'uuid-here',
  slug: 'my-check-slug',
  category: 'quality',
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

### File Scoping (Two-Layer Model)

- **Checks** declare intent: `scope: { languages: ['typescript'], concerns: ['backend'] }`
- **Targets** (`opensip-tools.config.yml`) declare reality: named file sets with `languages`, `concerns`, and include/exclude globs
- **Resolution**: `checkOverrides > scope matching > file cache fallback`
- **Global excludes**: `globalExcludes` in `opensip-tools.config.yml`
- **Per-check exemptions**: `@fitness-ignore-file <check-slug>` inline directives

## Coding Standards

### Testing

Use Vitest. Test files: `*.test.ts`. Run with `pnpm test` or `pnpm --filter=@opensip-tools/<pkg> test`.

### Imports

- Workspace packages: `import { x } from '@opensip-tools/core'`
- Subpath exports: `import { x } from '@opensip-tools/core/recipes/built-in-recipes.js'`
- Internal: relative paths within a package

## Before Committing

```bash
pnpm typecheck && pnpm test
```

## Releasing

Releases are tag-driven: bump the four package versions, commit, tag
`vX.Y.Z`, push. CI publishes to npm via OIDC trusted publishing.

**Read `RELEASING.md` before touching `.github/workflows/release.yml`.**
The workflow has two non-obvious steps (npm 11 to a separate prefix;
`pnpm pack` + `npm publish <tarball>`) that look like they could be
simplified but cannot — both work around concrete bugs in npm's self-
replacement and pnpm's lack of OIDC support, respectively.

## Project Status

Early-stage open-source project. This is a subset of the larger OpenSIP platform, focused on the portable analysis toolkit (fitness, simulation).
