---
status: current
last_verified: 2026-06-15
release: v0.1.13
title: "Plugin loader"
audience: [contributors, plugin-authors]
purpose: "How plugins are discovered, loaded, and registered. Source files, npm packages, project pinning, the sync command."
source-files:
  - packages/core/src/plugins/discover.ts
  - packages/core/src/plugins/marker-discovery.ts
  - packages/core/src/plugins/tool-package-discovery.ts
  - packages/core/src/plugins/types.ts
  - packages/config/src/capability-preferences.ts
  - packages/cli/src/commands/plugin.ts
  - packages/fitness/engine/src/cli/fit/check-loader.ts
  - packages/fitness/engine/src/plugins/
related-docs:
  - ../10-concepts/02-tool-plugin-model.md
  - ./01-cli-dispatch.md
  - ./03-session-and-persistence.md
  - ../50-extend/01-plugin-authoring.md
---
# Plugin loader

opensip-cli loads four kinds of plugins. Each has its own discovery shape, but they share a small, explicit policy: nothing loads silently, nothing loads transitively without opt-in, and the project owns its plugin set.

> **What you'll understand after this:**
> - The five discovery shapes (Tool marker; fit-pack marker + augmenting pin; sim-pack `scenarios-*` name pattern + pin; graph-adapter marker + explicit pin; language-adapter direct import) — the middle three now flow through the ONE generic capability substrate (§5.3 / ADR-0029).
> - Why source-file plugins auto-load but project-pinned npm packages require explicit listing.
> - The on-disk layout the `<tool> plugin add/remove/list/sync` commands operate on.
> - What `<tool> plugin sync` does and when CI should run it.

---

## The five discovery shapes

| Plugin kind | Discovery shape | Where loaded |
|---|---|---|
| **Tools** | `node_modules` walk for `opensipTools.kind === 'tool'` marker | At CLI startup, by `discoverToolPackages()` |
| **Check packs** (`fit-pack`) | (a) `node_modules` walk for the `fit-pack` marker plus target-domain epoch (built-ins resolve from the CLI install tree), (b) exact `plugins.checkPackages:` list ADDED to marker discovery. Co-located `recipes` route to the `fit-recipe` domain. | The GENERIC substrate (`discoverCapabilityContributions` → `loadCapabilityDomain`), driven by fitness's `ensureChecksLoaded()` |
| **Sim scenario packs** (`sim-pack`) | (a) Project-local source files under `opensip-cli/sim/`, (b) `node_modules` walk for `<scope>/scenarios-*` under default + configured `plugins.packageScopes`, (c) explicit `plugins.scenarioPackages:` pin. Co-located `recipes` route to the `sim-recipe` domain. | The GENERIC substrate, driven by simulation's `ensureScenariosLoaded()` |
| **Graph adapters** (`graph-adapter`) | (a) Explicit `plugins.graphAdapters:` list (pins the set), (b) `plugins.autoDiscoverGraphAdapters: false` opt-out, (c) default: `node_modules` walk for the `graph-adapter` marker plus target-domain epoch (built-ins from the CLI install tree; shared scaffolding like `@opensip-cli/graph-adapter-common` carries no marker and is skipped). | The GENERIC substrate, driven per command by the CLI pre-action hook (`loadOwningToolCapabilities`) |
| **Language adapters** | Direct CLI imports (no discovery walk) | At CLI bootstrap, before any tool is mounted |

Different kinds, different lifetimes. Tools are global to the binary — once registered, they're available regardless of cwd. Check packs and scenario packs are project-scoped — they load when the relevant Tool actually runs. Language adapters are bundled — they're a CLI dep, not a discoverable plugin, because the framework can't usefully run without them.

```mermaid
flowchart TB
  Startup["CLI startup"]
  FitRun["fit invocation"]
  SimRun["sim invocation"]
  GraphStartup["graph adapter bootstrap"]

  Tools["Tool packages<br/>opensipTools.kind = tool<br/>node_modules walk"]
  Languages["Bundled language adapters<br/>direct imports"]
  GraphAdapters["Graph adapters<br/>explicit config or<br/>opensipTools.kind = graph-adapter"]

  FitLocal["Project-local fit files<br/>opensip-cli/fit/checks<br/>opensip-cli/fit/recipes"]
  FitPinned["Project-pinned fit packages<br/>.runtime/plugins/fit + plugins.fit"]
  FitMarker["Fit-pack marker scan<br/>opensipTools.kind = fit-pack"]
  FitExact["Exact check package pins<br/>plugins.checkPackages"]

  SimLocal["Project-local sim files<br/>opensip-cli/sim/scenarios<br/>opensip-cli/sim/recipes"]
  SimPattern["Name-pattern scenario packages<br/>configured scopes / scenarios-*"]
  SimExact["Exact scenario package pins<br/>plugins.scenarioPackages"]
  SimPinned["Project-pinned sim packages<br/>.runtime/plugins/sim + plugins.sim"]

  Startup --> Tools
  Startup --> Languages
  Startup --> GraphStartup
  GraphStartup --> GraphAdapters

  FitRun --> FitLocal
  FitRun --> FitPinned
  FitRun --> FitMarker
  FitRun --> FitExact

  SimRun --> SimLocal
  SimRun --> SimPattern
  SimRun --> SimExact
  SimRun --> SimPinned
```

---

## Tool discovery (`opensipTools.kind === 'tool'`)

[`packages/core/src/plugins/tool-package-discovery.ts`](../../../packages/core/src/plugins/tool-package-discovery.ts) implements the walk. The CLI passes its own install directory as the `projectDir` argument (`packages/cli/src/index.ts` — `cliInstallDir = dirname(__dirname)` inside `loadDiscoveredTools()`); the function then walks upward through that directory's ancestors, looking at each `node_modules/`. Anchoring discovery at the CLI's install location (rather than the user's cwd) is deliberate — third-party tool packages installed alongside `opensip-cli` are picked up regardless of where the user runs the binary from. For each `node_modules` entry (and one level into scoped directories like `@opensip-cli/`), inspect the `package.json`:

```ts
const isToolPackage = (pkgDir: string): boolean => {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return pkgJson?.opensipTools?.kind === TOOL_KIND;
};
```

Discovery is by *marker*, not by name prefix. A name-prefix rule would break the moment a third-party scope publishes its own opensip-cli tool: `@my-company/opensip-cli-audit` doesn't match `^@opensip-cli/`. The marker is publication-scope-independent.

Discovery is **deduplicated by package name** with nearest-ancestor wins. If a project's `node_modules/@my-co/audit/` and the workspace root's `node_modules/@my-co/audit/` both declare a tool, the project's local copy wins — same as Node's module resolution.

Discovery is **synchronous and at startup**. Tools are cheap (each one is a small adapter); the walk completes in single-digit milliseconds. There is no lazy-load path for tools; either the package is installed by argv parse time or it doesn't exist for this run.

The bundled tools (`@opensip-cli/fitness`, `@opensip-cli/simulation`,
`@opensip-cli/graph`) declare the same `opensipTools.kind === 'tool'` marker.
They are **not** imported statically — `register-tools.ts` lists them by
package name (`BUNDLED_TOOL_PACKAGES`) and loads each through the same
`loadToolManifest → admitTool → dynamic import → register` path a third-party
tool travels (the `no-bootstrap-tool-import` check fails the build if a static
`import { fitnessTool }` creeps back). The registry is **first-writer-wins**, so
the bundled registration is the incumbent and a later same-id discovery is
skipped with a warning.

---

## Fit / sim plugin discovery

The fitness and simulation engines each have their own discovery, layered over the project paths defined in [`packages/core/src/lib/paths.ts`](../../../packages/core/src/lib/paths.ts). The shape is the same for both; the difference is the subdirectory names (`fit/checks`, `fit/recipes` vs. `sim/scenarios`, `sim/recipes`).

[`packages/core/src/plugins/discover.ts`](../../../packages/core/src/plugins/discover.ts) walks two sources:

### 1. User-source files (always auto-loaded)

```
<project>/opensip-cli/fit/checks/
<project>/opensip-cli/fit/recipes/
<project>/opensip-cli/sim/scenarios/
<project>/opensip-cli/sim/recipes/
```

Every `.js` or `.mjs` file recursively under those directories is loaded via dynamic `import()`. The loader records nested files with a slash-normalized relative source path, so category folders such as `opensip-cli/fit/checks/security/no-eval.mjs` are valid. Export shapes are domain-specific:

- Fit checks can be exported as a `checks` array, named `defineCheck(...)` exports, or a default single check.
- Fit recipes and sim scenarios/recipes use the `recipes` / `scenarios` array exports shown in the authoring docs.

The loader is forgiving — it loads what it finds and logs (but doesn't throw) on modules whose shape doesn't match. A broken file produces a load-time warning; the rest of the project continues.

These files are **always loaded**. There's no opt-in required because they're already part of the project — you wrote them, you committed them, they're inside `<project>/opensip-cli/`. The auto-loading is the affordance.

### 2. Project-pinned npm-package plugins

```
<project>/opensip-cli/.runtime/plugins/fit/node_modules/<pkg>/
<project>/opensip-cli/.runtime/plugins/sim/node_modules/<pkg>/
```

Plus the matching list in `opensip-cli.config.yml`:

```yaml
plugins:
  fit:
    - '@my-org/checks-internal'         # arbitrary scope — must be pinned
  sim:
    - '@my-org/sim-scenarios'
```

The discoverer walks `.runtime/plugins/<domain>/node_modules/` but **only loads the packages explicitly listed in `plugins.<domain>:`**. Everything else in node_modules (transitive deps, hoisted packages, accidental installs) is ignored.

The explicit list is the contract for arbitrary-scope packs. A transitive devDep can't silently inject checks — the user (or the `<tool> plugin add` command) has to add its name to `plugins.<domain>:` for it to load.

### 3. Marker-based check-pack discovery (fit)

Beyond the project-pinned form, fitness runs marker discovery on every fit invocation and merges in any exact `plugins.checkPackages:` entries, deduplicating by package name (explicit config wins on collision):

**Pass A — marker scan, canonical path** ([`packages/core/src/plugins/marker-discovery.ts`](../../../packages/core/src/plugins/marker-discovery.ts)). The `node_modules` walker scans every installed package for `package.json` declaring the `fit-pack` marker plus target-domain epoch. Discovery is publication-scope-independent — a pack can use any npm name (`@acme/fit`, `@my-internal-org/checks-platform`, anything) and still be discovered.

**Pass B — exact package list** ([`packages/config/src/capability-preferences.ts`](../../../packages/config/src/capability-preferences.ts), driven by [`packages/fitness/engine/src/cli/fit/check-loader.ts`](../../../packages/fitness/engine/src/cli/fit/check-loader.ts)). `plugins.checkPackages:` names additional packages to resolve from project `node_modules`. This is the compatibility path for packages that do not declare the marker yet:

```yaml
plugins:
  checkPackages:
    - '@my-org/fitness-checks'
```

No package is privileged — the bundled packs (`@opensip-cli/checks-universal`, `@opensip-cli/checks-typescript`, etc.) carry the marker and are discovered through the same contract as third-party packs. Add a marker-tagged pack to your project's `dependencies`, and it's loaded on the next run with no further wiring.

### Producer vs consumption provenance

First-party OpenSIP packages are published with npm **producer provenance**
(OIDC + `--provenance`). **Consumption-side** verification — checking provenance
when a project installs or loads a third-party pack — is a documented trust gate
([ADR-0068](../../decisions/ADR-0068-consumption-side-verification-policy.md)) that
is **not implemented** in the loader yet. Until spec 03 lands enforcement, admission
remains trust-tier + allowlist policy only.

The marker shape is what makes "install and use" frictionless without constraining npm names. The exact-list shape (`plugins.checkPackages:`) handles non-marker packages. Project-pinned fit packs (`plugins.fit:`) are managed by `opensip fit plugin add/remove/sync`.

---

## 4. Language adapter "discovery" — actually direct imports

[`packages/cli/src/bootstrap/register-language-adapters.ts`](../../../packages/cli/src/bootstrap/register-language-adapters.ts) registers the six bundled language adapters into the per-invocation `LanguageRegistry`:

```ts
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { rustAdapter }       from '@opensip-cli/lang-rust';
// ... four more ...

langRegistry.register(typescriptAdapter);
langRegistry.register(rustAdapter);
langRegistry.register(pythonAdapter);
langRegistry.register(javaAdapter);
langRegistry.register(goAdapter);
langRegistry.register(cppAdapter);
```

This isn't discovery. It's an explicit static call from `bootstrapCli()`. Why?

- Language adapters are needed *before* any Tool runs. A check that runs against a language with no registered adapter would treat every file as raw text — silent miss.
- The six bundled adapters are part of the CLI's contract. A project that needs Rust support gets it without installing anything; same for the others.
- A custom language adapter (say, `@my-co/lang-erlang`) would need a future plugin path to be added — today's CLI registers only the six bundled adapters. The `LangPluginExports` shape ([`packages/core/src/plugins/types.ts:29`](../../../packages/core/src/plugins/types.ts)) exists as a forward-compatible export shape, but no discovery walker reads it yet.

---

## The `<tool> plugin` command surface

CLI-owned commands for managing the npm-package extension-pack layout. Source: [`packages/cli/src/commands/plugin.ts`](../../../packages/cli/src/commands/plugin.ts).

The `plugin` group is mounted **under each pack-supporting tool primary** — the domain is bound from the tool, so there is **no top-level `opensip plugin`** and **no `--domain` flag**. `fit` and `sim` support packs; `graph` does not, so it has no `plugin` group. Whole Tool plugins (a `kind: "tool"` package contributing a whole subcommand) are NOT managed here — they install/uninstall with `opensip tools …` (see [`70-reference/12-tools-command.md`](../70-reference/12-tools-command.md)).

```bash
opensip fit plugin list                   # what fit packs are installed and loaded
opensip fit plugin add <pkg>              # project-pinned fit pack
opensip fit plugin remove <pkg>           # remove fit pack + config entry
opensip fit plugin sync                   # install everything declared under plugins.fit

opensip sim plugin list                   # the same, bound to the sim domain
opensip sim plugin add <pkg>
opensip sim plugin remove <pkg>
opensip sim plugin sync
```

### `<tool> plugin add <pkg>`

Two operations happen in one command (the domain is the tool the subcommand hangs off of — `fit` or `sim`):

1. Install `<pkg>` into `<project>/opensip-cli/.runtime/plugins/<domain>/`. The runtime dir's `package.json` is the install host — its `dependencies` block tracks installed plugins.
2. Append `<pkg>` to `plugins.<domain>:` in `opensip-cli.config.yml`. Idempotent — adding the same name twice is a no-op.

The domain is bound from the tool primary, not inferred or flagged. The package-manager call is wrapped in `execFileSync` (no shell, no metacharacter expansion) and the package spec is validated to refuse anything starting with `-` so package-manager flags cannot become an injection vector. Extension packs are always **project-local** — there is no user-global pack path, so there is no `--project` flag.

### `<tool> plugin remove <pkg>`

The inverse of add: `npm uninstall <pkg>` from the host directory, then remove the entry from `plugins.<domain>:` in the config. The runtime dir stays — only the package's own `node_modules` entry goes away.

### `<tool> plugin list`

Walks `.runtime/plugins/<domain>/node_modules/` for the bound domain and intersects with the config's `plugins.<domain>:` list:

- **Installed and loaded** — package present in node_modules AND listed in config. Will be loaded on the next run.
- **Installed but not loaded** — present but not listed. Either a transitive dep or an `add` that crashed before updating the config.
- **Listed but not installed** — listed but missing from node_modules. Run `<tool> plugin sync`.

Whole Tool plugins are NOT listed here — that is `opensip tools list`.

### `<tool> plugin sync`

Reads `plugins.<domain>:` from the config and installs each entry for the bound domain. The bootstrap-after-clone command. CI should run `opensip fit plugin sync` (and/or `opensip sim plugin sync`) between checkout and `fit` so PR builds have the same pack set the author tested against.

`<tool> plugin sync` is also the right command after switching branches if the new branch added or removed that tool's packs. The runtime dir is gitignored, so plugin state doesn't follow a branch checkout — `sync` is what makes the runtime match the config.

---

## Why this layout

A few alternatives considered and rejected:

- **User-global fit/sim plugin dir.** Earlier designs had one global plugin dir for checks and scenarios. Rejected: every project gets the same fit/sim packs, which means a teammate without your global plugin can't reproduce your run. Project-local fit/sim plugins are the contract. The user-level plugin host is reserved for whole Tool plugins, where "this subcommand exists on my machine" is the intended scope.
- **Auto-load every package in node_modules.** Rejected: too many surprises. A transitive `@opensip-cli/checks-foo` from a regular dep would inject checks. The explicit `plugins.<domain>:` list is the opt-in.
- **Plugins as workspace packages.** Rejected for non-monorepo projects. Plugins are external dependencies; the runtime dir isolates them from the project's main `package.json` so a plugin install doesn't bloat the project's lockfile.
- **Lazy plugin discovery (only load what the recipe needs).** Rejected: it would tie discovery to recipe selection, which couples the recipe author to the plugin layout. Today, every plugin loads every run (cheap — the plugin universe is small) and the recipe filters checks at selection time.

---

## Where the example lands

For `acme-api`:

- `<project>/opensip-cli/fit/checks/` carries three `.mjs` files (custom checks). Auto-loaded every run.
- `<project>/opensip-cli/fit/recipes/` carries `quick-smoke.mjs` and `infra.mjs`. Auto-loaded every run.
- `<project>/opensip-cli.config.yml` declares project-pinned third-party packs:
  ```yaml
  plugins:
    fit:
      - '@acme/checks-internal'
  ```
- `<project>/opensip-cli/.runtime/plugins/fit/node_modules/` carries that package, installed by `opensip fit plugin add` (or by `opensip fit plugin sync` after a fresh clone). The first-party `@opensip-cli/checks-*` packs are bundled/marker-discovered; `plugins.fit` is for project-pinned install state managed by `opensip fit plugin add` / `opensip fit plugin sync`.

CI's pipeline:

```bash
git clone …
cd acme-api
curl -fsSL https://opensip.ai/cli/install.sh | bash
opensip fit plugin sync       # bootstrap project-pinned fit packs
opensip fit --gate-compare    # the actual gate
```

---

## What's next

- **[`03-session-and-persistence.md`](./03-session-and-persistence.md)** — what gets written to disk when a run actually executes.
- **[`../50-extend/01-plugin-authoring.md`](../50-extend/01-plugin-authoring.md)** — how to build a check pack, scenario pack, or Tool that gets discovered by this loader.
