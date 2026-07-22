---
status: current
last_verified: 2026-07-21
release: v0.8.4
title: "Repository layout"
audience: [contributors]
purpose: "Why each tracked root entry exists, which paths are discovery contracts, and which generated directories are safe to clean."
source-files:
  - .git-blame-ignore-revs
  - .gitignore
  - .nvmrc
  - .prettierignore
  - AGENTS.md
  - CHANGELOG.md
  - CLAUDE.md
  - CONTRIBUTING.md
  - LICENSE
  - NOTICE
  - README.md
  - RELEASING.md
  - SECURITY.md
  - SUPPORT.md
  - action.yml
  - opensip-cli.config.yml
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - scripts/build-agents-md.mjs
  - scripts/build-web-docs.mjs
  - scripts/github-action/run.mjs
  - tsconfig.json
  - turbo.json
related-docs:
  - ../README.md
  - ../60-guides/03-wire-into-ci.md
  - ./03-session-and-persistence.md
  - ./architecture-map.md
  - ./04-coding-standards.md
  - ./06-doc-conventions.md
---
# Repository layout

The opensip-cli root is the composition point for a pnpm/Turborepo monorepo, a
public GitHub Action, the project's own OpenSIP configuration, and several agent
clients. That makes it busier than a single-package library root, but each
tracked entry has a defined owner.

> **What you'll understand after this:**
> - Which root paths are required by package managers, GitHub, OpenSIP, or agent clients.
> - Which files are authoritative and which are generated mirrors.
> - Why the root `opensip-cli/` directory is not a nested copy of the repository.
> - Which ignored directories are disposable caches and which contain retained evidence.

---

## Root overview

```text
opensip-cli/
├── packages/                 # workspace packages and the CLI composition root
├── scripts/                  # repository build, verification, release, and docs automation
├── docs/                     # public docs, ADRs, generated website projection, local plans
├── opensip-cli/              # project-local dogfood checks and managed runtime state
├── .config/                  # explicitly addressed tool configs, budgets, and baselines
├── .github/                  # workflows, repository metadata, and nested Actions
├── .githooks/                # repository-owned Git hooks
├── .agents/                  # AGENTS.md-oriented agent skills
├── .claude/                  # Claude Code settings and skills
├── .codex/                   # Codex project configuration
├── action.yml                # published root GitHub Action manifest
├── opensip-cli.config.yml    # this repository's OpenSIP project configuration
├── package.json              # workspace scripts and root development dependencies
├── pnpm-workspace.yaml       # workspace membership
├── turbo.json                # task graph and cache policy
└── tsconfig.json             # shared TypeScript compiler baseline
```

The package-level architecture beneath `packages/` is generated separately in
the [architecture map](./architecture-map.md). This page owns the repository
root rather than duplicating that package inventory.

---

## Root files

| Path | Role | Why it lives at the root / how to maintain it |
|---|---|---|
| `.git-blame-ignore-revs` | Lists formatting-only commits that should not obscure substantive authorship in blame views. | Keep beside the Git history it describes. Add only large, behavior-neutral formatting commits. Local Git can enable it with `git config blame.ignoreRevsFile .git-blame-ignore-revs`. |
| `.gitignore` | Excludes dependencies, build output, runtime evidence, reports, and other generated state. | Git discovers it hierarchically from the repository root. Add the narrowest rule that covers a generated artifact. |
| `.nvmrc` | Declares the contributor Node.js version. | Root placement lets `nvm use` and compatible tools discover it automatically. Keep it aligned with `package.json#engines` and CI. |
| `.prettierignore` | Excludes generated or unsuitable files from formatting. | Prettier and editor integrations conventionally discover it at the root; package scripts also pass it explicitly. |
| `AGENTS.md` | Agent guidance for clients that implement the AGENTS.md convention. | Generated from `CLAUDE.md`. Never hand-edit it; edit `CLAUDE.md`, then run `pnpm agents:build`. |
| `CHANGELOG.md` | User-visible release history. | Root placement is conventional for releases and package consumers. Update it through the release-prep workflow. |
| `CLAUDE.md` | Canonical repository guidance for coding agents. | This is the hand-edited source for `AGENTS.md`; keep architectural rules and command guidance here synchronized with the implementation. |
| `CONTRIBUTING.md` | Contributor setup, development workflow, and submission guidance. | GitHub surfaces root community files, and new contributors can find it without knowing the docs layout. |
| `LICENSE` | Apache-2.0 license text. | Root placement makes the repository and packaged source licensing unambiguous. Package license copies are synchronized separately. |
| `NOTICE` | Required attribution and notice material distributed with the project. | Lives beside `LICENSE` and must remain consistent with release artifacts. |
| `README.md` | Repository landing page and product-level quick reference. | GitHub renders it automatically at the repository root. Detailed material belongs under `docs/public/`. |
| `RELEASING.md` | Maintainer release procedure, ordering, verification, and recovery instructions. | Kept prominent because release work spans the entire workspace. Use the release-prep skill and release scripts rather than copying commands elsewhere. |
| `SECURITY.md` | Supported security-reporting process. | GitHub recognizes it as a community health file and exposes it to reporters. |
| `SUPPORT.md` | Contributor and CI toolchain support matrix. | Keep it aligned with `package.json`, `.nvmrc`, and supported-platform evidence. |
| `action.yml` | Manifest for the reusable `opensip-ai/opensip-cli@…` GitHub Action. | Root placement enables the short Action reference. It sets up Node and delegates to `scripts/github-action/run.mjs`; it is not an automatically triggered workflow. |
| `opensip-cli.config.yml` | The configuration used when this repository dogfoods OpenSIP. | OpenSIP discovers this filename at the project root. It defines targets, suites, plugins, and tool namespaces. |
| `package.json` | Root scripts, development dependencies, package-manager pin, and runtime requirements. | pnpm, Corepack, Turbo, and repository automation use it as the workspace composition manifest. |
| `pnpm-lock.yaml` | Reproducible dependency resolution for every workspace package. | Generated and updated by pnpm, but committed as an authoritative install input. Do not edit it manually. |
| `pnpm-workspace.yaml` | Declares which directories are pnpm workspace members. | pnpm expects it at the workspace root. Update it when adding or removing package families. |
| `tsconfig.json` | Shared TypeScript compiler baseline. | Package configs extend it; build, typecheck, and graph tooling use the root as the common project boundary. |
| `turbo.json` | Turborepo task graph, dependencies, outputs, and cache inputs. | Turbo discovers it at the workspace root. Change it when task orchestration changes, not for package-local compiler behavior. |

---

## Root directories

| Path | Role | Ownership rule |
|---|---|---|
| `.agents/` | Skills for agent clients that use the AGENTS.md-oriented repository surface. | Keep client-specific references aligned with `AGENTS.md`; do not assume `.claude/` consumes identical paths. |
| `.claude/` | Claude Code settings, ignored session state, and Claude-specific skills. | Repository settings may be committed; ephemeral client state remains ignored. |
| `.codex/` | Codex project configuration. | Keep only project-scoped configuration here; personal state belongs outside the repository. |
| `.config/` | ESLint, Prettier, Vitest, Knip, dependency-cruiser, quality budgets, compatibility data, and other explicitly addressed repository configuration. | Put specialized configuration here when the owning tool can be passed an explicit path. Keep conventional auto-discovery files at the root. |
| `.githooks/` | Repository-owned hooks selected by the root `prepare` script. | Hooks should be deterministic, fast, and backed by the same checks CI runs. |
| `.github/` | GitHub workflows, Dependabot configuration, issue/repository metadata, and nested reusable Actions. | The root `action.yml` is the public default Action; specialized Actions can live below `.github/actions/`. |
| `docs/` | Public documentation, decisions, generated website content, and local-only planning areas. | Edit `docs/public/` and ADR sources, never `docs/web-generated/` directly. Run `pnpm docs:build` after public-doc changes. |
| `opensip-cli/` | Reserved project-local OpenSIP namespace. In this repository it contains authored dogfood checks, fixtures, and seam exemptions. | It is not another checkout and it is not the npm CLI package. The actual CLI package is `packages/cli/`. Authored content is tracked; `.runtime/` is ignored. |
| `packages/` | pnpm workspace packages arranged by architectural layer and tool domain. | Package membership comes from `pnpm-workspace.yaml`; dependency direction is enforced by dependency-cruiser. |
| `scripts/` | Cross-workspace build, verification, release, benchmark, acceptance, and generation automation. | Prefer a script here when orchestration spans packages or owns a repository-wide invariant. Package-local behavior stays with its package. |

---

## Generated local state

Generated directories can dominate disk usage even though they are not tracked
root clutter. Their cleanup semantics are different:

| Path | Contents | Cleanup posture |
|---|---|---|
| `node_modules/` | Installed workspace dependencies and pnpm links. | Reproducible from the lockfile. Removing it is safe but requires another `pnpm install`. |
| `.turbo/` | Local Turborepo task cache. | Disposable. Removing it only makes later tasks recompute their outputs. |
| `opensip-cli/.runtime/` | Stored runs and sessions, graph catalogs, reports, logs, baselines, tool state, and installed project plugins. | Retained evidence, not merely a cache. Inspect or purge sessions through `opensip sessions …`; preview full removal with `opensip uninstall --project --dry-run`. Do not delete it casually when historical evidence matters. |

Generated `dist/`, coverage, SARIF, benchmark, and profiling artifacts are also
ignored by targeted rules in `.gitignore`. A new generated artifact should gain
an explicit owner and ignore rule rather than becoming an unexplained root file.

---

## Placement and maintenance rules

- Treat the root as a discovery and composition surface. Do not move a file only
  for visual tidiness when pnpm, GitHub, Git, OpenSIP, or an agent client expects
  its conventional path.
- Consolidate specialized tooling under `.config/` when the tool accepts an
  explicit config path. Leave conventional discovery files such as `.nvmrc` and
  `.gitignore` at the root.
- Keep authoritative/generated relationships explicit: `CLAUDE.md` generates
  `AGENTS.md`, `docs/public/` generates `docs/web-generated/`, and package source
  generates the architecture map and other derived references.
- Avoid embedding volatile package counts or dependency versions in this page.
  Link to generated inventories and manifests instead.
- When a permanent root entry is added, removed, or changes ownership, update
  this page in the same change.

---

## Verification trail

Last verified at v0.8.3 against:

- `git ls-tree --name-only HEAD` for the tracked root inventory.
- Root manifests and package scripts for tool discovery and composition paths.
- `.gitignore` for generated-state ownership.
- The agent and web-doc generators for authoritative/generated relationships.
- The GitHub Action entrypoint and OpenSIP session/uninstall commands for runtime behavior.

---

## What's next

- **[`architecture-map.md`](./architecture-map.md)** — current package inventory and layer placement beneath `packages/`.
- **[`04-coding-standards.md`](./04-coding-standards.md)** — source, test, import, logging, and error conventions.
- **[`05-layer-policy.md`](./05-layer-policy.md)** — dependency direction enforced across workspace packages.
- **[`06-doc-conventions.md`](./06-doc-conventions.md)** — how contributor-facing documentation is written and verified.
