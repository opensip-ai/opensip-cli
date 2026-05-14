# v3.0.0 — Onboarding & directory layout refactor

**Posture:** breaking change to the project-local directory contract.
Users with v2.x layouts get a one-shot auto-migration with a friendly
notice; v3 is the new shape.

**Outcome:** A first-time customer experience that proves the whole
pipeline end-to-end in three commands:

```bash
$ npm install -g @opensip-tools/cli
$ cd ~/my-project
$ opensip-tools init                     # detects language, scaffolds layout
$ opensip-tools fit --recipe example     # smoke test — runs the example check
$ opensip-tools sim --recipe example     # smoke test — runs the example scenario
```

After step 4 the user has confirmed that the CLI is installed, found
their project, loaded their config, registered their custom check and
scenario via auto-discovery, executed both through their custom
recipe, and rendered the result. From here, they edit (or delete) the
example files and write their own.

No "now declare your plugins in the config" step. If
`opensip-tools/fit/checks/foo.mjs` exists, it's loaded.

## Directory contract

After v3:

```
my-project/
├── .git/                              ← unchanged
├── .gitignore                         ← updated by `init`
├── opensip-tools.config.yml           ← TRACKED — project config
├── opensip-tools/                     ← TRACKED — user-authored
│   ├── fit/
│   │   ├── checks/
│   │   │   └── example-check.mjs      ← scaffolded by init
│   │   └── recipes/
│   │       └── example-recipe.mjs     ← scaffolded by init
│   ├── sim/
│   │   ├── scenarios/
│   │   │   └── example-scenario.mjs   ← scaffolded by init
│   │   └── recipes/
│   │       └── example-recipe.mjs     ← scaffolded by init
│   └── .runtime/                      ← GITIGNORED — runtime state
│       ├── sessions/                  ← run history (was ~/.opensip-tools/sessions)
│       ├── reports/                   ← dashboard HTML (was ~/.opensip-tools/reports)
│       ├── logs/                      ← structured JSONL (was ~/.opensip-tools/logs)
│       ├── baseline.sarif             ← gate baseline (was .opensip-tools/baseline.sarif)
│       ├── cache/                     ← AST + prewarm caches
│       └── plugins/                   ← npm-installed plugin packages
│           ├── fit/
│           └── sim/
├── package.json
└── src/
```

The `checks/` vs `recipes/` (and `scenarios/` vs `recipes/`) split is
deliberate: those are different domain types with different roles, and
keeping them separated at the directory level matches how the
framework already thinks about them. A user looking at
`opensip-tools/fit/` immediately sees both buckets and knows where to
put each kind of artifact.

`~/.opensip-tools/` retains ONLY:
- `config.yml` — user-level identity (cloud API key, default theme, etc.)

Everything else moves into `<project>/opensip-tools/.runtime/`.

## Custom check / scenario authoring is JS/TS only

Custom checks and scenarios are dynamically imported as ESM modules at
runtime — they HAVE to be JavaScript (or TypeScript transpiled to JS).
A user authoring checks in Rust isn't possible without an FFI bridge
or a separate non-Node runtime, both of which are far out of scope.

This is a constraint of the platform, not a design choice we can
revisit. What we CAN do is make sure the *target codebase being
scanned* can be any language with a registered LanguageAdapter
(typescript, rust, python, go, java, c/c++). The scaffold needs to
generate a check whose `scope.languages` and a config whose `targets`
match the user's actual codebase — that's what `--language` solves.

The split:

| Layer | Path | Tracked? | Rationale |
|-------|------|----------|-----------|
| User identity | `~/.opensip-tools/config.yml` | n/a | persists across machines (or doesn't, that's user choice) |
| Project config | `<project>/opensip-tools.config.yml` | yes | reproducible across clones |
| User source | `<project>/opensip-tools/{fit,sim}/` | yes | custom checks/scenarios |
| Runtime state | `<project>/opensip-tools/.runtime/` | no | sessions, logs, cache |

## Breaking changes

1. **Plugin auto-load semantics flip.** v2: project-local plugins
   require `plugins.fit:` declaration in config. v3:
   `opensip-tools/fit/checks/*.mjs` and `opensip-tools/fit/recipes/*.mjs`
   are auto-loaded by directory presence; same for sim's
   `scenarios/*.mjs` and `recipes/*.mjs`. The config declaration is
   reserved for npm-package plugin pinning.

2. **Plugin install location moves.** v2: `~/.opensip-tools/fit/node_modules/`
   user-globally. v3: `<project>/opensip-tools/.runtime/plugins/fit/node_modules/`
   project-locally.

3. **Session/log/report/baseline locations move.** Tool-generated
   state is now per-project under `.runtime/`.

4. **`init` scaffolds more, with language detection.** Today it
   generates an empty `opensip-tools.config.yml`. v3 detects the
   project's primary language (Cargo.toml → rust, pyproject.toml →
   python, etc.) and scaffolds the full layout: language-appropriate
   target globs in the config, `example-check.mjs` with a matching
   `scope.languages`, an `example-recipe.mjs` that references it,
   matching sim scaffolds, and a `.gitignore` entry for the runtime
   dir.

5. **`opensip-tools/fit/` and `opensip-tools/sim/` gain subdirectories.**
   v2's flat plugin dir (`.opensip-tools/fit/*.mjs` mixing checks and
   recipes) becomes a structured layout: `fit/checks/` and
   `fit/recipes/`, sim/`scenarios/` and sim/`recipes/`. Migration
   moves existing files to the appropriate subdir based on what they
   export (`checks` → `checks/`, `recipes` → `recipes/`).

## Migration

`opensip-tools` detects v2.x state on first run and runs an
auto-migration with a notice:

```
opensip-tools: detected v2.x layout, migrating to v3 layout...
  • opensip-tools.config.yml → unchanged
  • plugins.fit / plugins.sim entries → unchanged (still valid for npm pinning)
  • .opensip-tools/fit/*.mjs → opensip-tools/fit/{checks|recipes}/
    (sorted by what each file exports: `checks` array → checks/,
     `recipes` array → recipes/, both → mirrored in both)
  • .opensip-tools/sim/*.mjs → opensip-tools/sim/{scenarios|recipes}/
  • .opensip-tools/baseline.sarif → opensip-tools/.runtime/baseline.sarif
  • .opensip-tools/ → REMOVED after move
  • ~/.opensip-tools/sessions/<this-project>/ → opensip-tools/.runtime/sessions/
    (Migration only takes sessions whose `cwd` matches this project.
     User-global sessions for OTHER projects stay in ~/.opensip-tools/sessions/
     until those projects run their own first migration.)
  • ~/.opensip-tools/logs/ → kept (logs are append-only and small)
  • Adds opensip-tools/.runtime/ to .gitignore (creates .gitignore if missing)

opensip-tools: migration complete. ~/.opensip-tools/ retained for user-level config only.
```

`opensip-tools` writes a `.runtime/migrated-from-v2` marker so the
migration runs at most once per project.

## CLI surface changes

### `opensip-tools init` — language-aware scaffolding

`init` detects the project's primary language(s) and scaffolds
language-appropriate targets, example checks, and example recipes. A
`--language` flag lets the user override detection or specify
explicitly.

#### Detection rules (cheap, unambiguous)

| Project marker at root | Detected language |
|---|---|
| `Cargo.toml` | rust |
| `pyproject.toml` or `setup.py` | python |
| `go.mod` | go |
| `pom.xml` or `build.gradle` | java |
| `CMakeLists.txt` or `*.h`+`*.cpp` cluster | cpp |
| `package.json` + `tsconfig.json` | typescript |
| `package.json` only | typescript (file globs include `*.js`) |

If multiple markers match, detection falls through to a prompt — the
user explicitly chooses.

#### Flag forms

```bash
$ opensip-tools init                            # default — detect
$ opensip-tools init --language rust            # explicit single language
$ opensip-tools init --language rust,typescript # explicit polyglot (DART)
$ opensip-tools init --language <lang> --force  # overwrite an existing config
```

`--language` accepts a comma-separated list. Each declared language
generates one named target in the config plus a corresponding
`scope.languages` entry on the example check. Polyglot projects (Rust
+ TypeScript like DART) get separate targets so checks can scope to
each language independently.

#### Detection-success path

```bash
$ cd ~/my-rust-project   # has Cargo.toml
$ opensip-tools init
opensip-tools: detected Rust project (Cargo.toml found)
  ✓ created opensip-tools.config.yml         (rust-source target, target/** excluded)
  ✓ created opensip-tools/fit/checks/example-check.mjs       (scope: rust)
  ✓ created opensip-tools/fit/recipes/example-recipe.mjs
  ✓ created opensip-tools/sim/scenarios/example-scenario.mjs
  ✓ created opensip-tools/sim/recipes/example-recipe.mjs
  ✓ added opensip-tools/.runtime/ to .gitignore

Try it:
  opensip-tools fit --recipe example
  opensip-tools sim --recipe example
```

#### Detection-ambiguous path

```bash
$ cd ~/polyglot-project   # has both go.mod and package.json
$ opensip-tools init
opensip-tools: could not determine primary language. Please specify:

  opensip-tools init --language <typescript|rust|python|go|java|cpp>

  For polyglot projects, use a comma-separated list:
  opensip-tools init --language rust,typescript

Detected file markers:
  - go.mod        (suggests: go)
  - package.json  (suggests: typescript)
```

Exit code: 2 (configuration required). No partial scaffolding — the
user re-invokes with `--language`.

#### Scaffolded files

`opensip-tools.config.yml` (after `init --language rust`):
```yaml
globalExcludes:
  - "target/**"        # Rust build output
  - "**/*.lock"

targets:
  rust-source:
    description: Rust source code
    languages: [rust]
    concerns: [backend]
    include:
      - "src/**/*.rs"
      - "crates/**/*.rs"
    exclude:
      - "**/target/**"

fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
```

`opensip-tools/fit/checks/example-check.mjs`:
```js
// Example fitness check — flags any source file containing "EXAMPLE_TODO".
// Edit this file or add new .mjs files to opensip-tools/fit/checks/ —
// they'll be auto-loaded on the next `opensip-tools fit` run.
import { defineCheck } from '@opensip-tools/fitness';

export const checks = [
  defineCheck({
    id: '01J0EXAMPLE0CHECK0000000000',
    slug: 'example-check',
    description: 'Demo check — flags any file containing the literal EXAMPLE_TODO',
    scope: { languages: ['rust'], concerns: ['backend'] },   // matches detected language
    tags: ['example'],
    analyze: (content, filePath) => {
      const i = content.indexOf('EXAMPLE_TODO');
      if (i < 0) return [];
      return [{
        line: content.slice(0, i).split('\n').length,
        message: 'Found the example trigger string.',
        severity: 'warning',
        suggestion:
          'This is just a demo. Delete opensip-tools/fit/checks/example-check.mjs ' +
          'once you have your own checks.',
        filePath,
      }];
    },
  }),
];
```

`opensip-tools/fit/recipes/example-recipe.mjs`:
```js
// Example fitness recipe — runs only the example-check.
// Edit this file or add new .mjs files to opensip-tools/fit/recipes/ —
// they'll be auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools fit --recipe example
//
// To run all enabled checks (built-in + your custom ones), omit
// --recipe and the built-in `default` recipe applies.
export const recipes = [{
  id: 'URCP_example',
  name: 'example',
  displayName: 'Example',
  description: 'Demo recipe — runs only the example-check',
  checks: { type: 'explicit', checkIds: ['example-check'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

`opensip-tools/sim/scenarios/example-scenario.mjs`:
```js
// Example simulation scenario — completes immediately.
// Edit this file or add new .mjs files to opensip-tools/sim/scenarios/ —
// they'll be auto-loaded on the next `opensip-tools sim` run.
import { defineLoadScenario } from '@opensip-tools/simulation';

export const scenarios = [
  defineLoadScenario({
    id: 'example-scenario',
    name: 'example-scenario',
    description: 'Demo scenario — completes immediately',
    tags: ['example'],
    personas: [],
    duration: 0,
    assertions: [],
  }),
];
```

`opensip-tools/sim/recipes/example-recipe.mjs`:
```js
// Example simulation recipe — runs only the example-scenario.
// (Sim recipes are an in-development concept; this scaffold uses the
//  intended shape so users can see the pattern.)
export const recipes = [{
  id: 'URCP_sim_example',
  name: 'example',
  displayName: 'Example',
  description: 'Demo recipe — runs only the example-scenario',
  scenarios: { type: 'explicit', scenarioIds: ['example-scenario'] },
  execution: { mode: 'parallel', timeout: 30_000 },
}];
```

For polyglot init (`--language rust,typescript`):
- Two targets in the config (`rust-source`, `typescript-source`)
- Two example checks: `example-check-rust.mjs` (scope rust) and
  `example-check-typescript.mjs` (scope typescript)
- One example recipe referencing both

### `opensip-tools fit` and `opensip-tools sim` — auto-load semantics

Today's resolution order in the plugin loader:

1. project-local `<project>/.opensip-tools/<domain>/` IF `plugins.<domain>` declared in config
2. else user-global `~/.opensip-tools/<domain>/`

v3 resolution order:

1. **project-local `<project>/opensip-tools/fit/{checks,recipes}/` if
   the parent directory exists** — no config opt-in needed. Same shape
   for `<project>/opensip-tools/sim/{scenarios,recipes}/`.
2. project-local npm-installed plugins from
   `<project>/opensip-tools/.runtime/plugins/<domain>/node_modules/`
   (loaded if `plugins.<domain>` declared in config — explicit pinning).
3. user-global `~/.opensip-tools/<domain>/` — KEPT for back-compat,
   deprecated; prints a one-line notice on first use suggesting
   `opensip-tools migrate`.

The loader walks the appropriate subdir(s) for each domain and
auto-discovers any `.mjs` exporting a `checks` / `recipes` /
`scenarios` array.

### `opensip-tools migrate` — explicit migration command

For users who want to run migration manually or against older states:

```bash
$ opensip-tools migrate                  # migrate this project
$ opensip-tools migrate --user           # migrate ~/.opensip-tools/ remnants
$ opensip-tools migrate --dry-run        # show what would change
```

The auto-migration on first run is just `migrate --silent` triggered by
detection.

### `opensip-tools plugin install` — installs project-local now

```bash
$ opensip-tools plugin install @org/checks-custom
```

Goes to `<project>/opensip-tools/.runtime/plugins/fit/node_modules/`,
not `~/.opensip-tools/fit/node_modules/`. The flag `--user` retains the
v2 behavior for users who want global installs (rare).

## Implementation phases

### Phase 0 — Sim recipes (framework support)

Sim recipes don't exist yet — the in-progress `define-recipe.ts` was
deleted during knip cleanup. Before we can scaffold a working
`opensip-tools sim --recipe example` smoke test, the framework has to
support sim recipes for real.

Mirror the fitness recipe shape closely so the user-facing concepts
parallel each other: a recipe is a named bundle that selects a set of
artifacts (checks for fit, scenarios for sim) and configures
execution.

New files in `packages/simulation/engine/src/recipes/`:

- `types.ts` — `SimulationRecipe`, `SimulationRecipeConfig`,
  `ScenarioSelector` (mirrors `CheckSelector`: `'all'`, `'explicit'`,
  `'tags'`, `'pattern'`).
- `registry.ts` — `SimulationRecipeRegistry`, `defaultSimulationRecipeRegistry`.
- `define-recipe.ts` — `defineSimulationRecipe()` factory.
- `service.ts` — recipe-driven scenario execution. Wraps the existing
  `runScenario(scenario)` path in a recipe-resolver layer that picks
  scenarios from the registry, applies the selector, and runs them
  according to the recipe's `execution.mode` (sequential vs parallel).
- `built-in-recipes.ts` — a single built-in `default` recipe that
  selects all enabled scenarios.

`packages/simulation/engine/src/index.ts` re-exports the new public
surface: `defineSimulationRecipe`, `SimulationRecipeRegistry`,
`defaultSimulationRecipeRegistry`, `SimulationRecipe`, `SimulationRecipeConfig`.

`packages/simulation/engine/src/cli/sim.ts` gains a `--recipe <name>`
flag (matching fit's). Without `--recipe`, the built-in `default`
applies. With `--recipe example`, the user's example recipe runs.

The Tool's `register()` method in `packages/simulation/engine/src/tool.ts`
adds the `--recipe` option to its Commander definition.

Tests: contract test for `defineSimulationRecipe()` (shape validation,
duplicate-id rejection, registry round-trip), integration test for
`SimulationRecipeService` (built-in default recipe runs all scenarios,
explicit recipe runs only listed scenarios).

Estimated time: 3 hours.

### Phase 1 — Path resolution layer

Refactor every hardcoded `'.opensip-tools'` and `homedir() +
'.opensip-tools'` into a single resolver in `@opensip-tools/core`:

```ts
// core/src/lib/paths.ts
export interface ProjectPaths {
  readonly configFile: string;            // <project>/opensip-tools.config.yml
  readonly userSourceDir: string;         // <project>/opensip-tools
  // Per-tool source layout — checks vs recipes vs scenarios.
  readonly fitChecksDir: string;          // <project>/opensip-tools/fit/checks
  readonly fitRecipesDir: string;         // <project>/opensip-tools/fit/recipes
  readonly simScenariosDir: string;       // <project>/opensip-tools/sim/scenarios
  readonly simRecipesDir: string;         // <project>/opensip-tools/sim/recipes
  // Runtime state.
  readonly runtimeDir: string;            // <project>/opensip-tools/.runtime
  readonly sessionsDir: string;
  readonly reportsDir: string;
  readonly logsDir: string;
  readonly cacheDir: string;
  readonly baselinePath: string;
  readonly pluginsDir: (domain: 'fit' | 'sim') => string;
}

export function resolveProjectPaths(projectDir: string): ProjectPaths;

export interface UserPaths {
  readonly configFile: string;            // ~/.opensip-tools/config.yml
}
export function resolveUserPaths(): UserPaths;
```

Every consumer (logger, persistence/store, gate, plugin loader,
configure command, uninstall command) calls these resolvers instead of
constructing paths inline.

### Phase 2 — Plugin loader behavior change

`discover.ts` and `loader.ts` (in fitness) gain new resolution behavior:

- For `fit`, walk `<project>/opensip-tools/fit/checks/` and
  `<project>/opensip-tools/fit/recipes/` — auto-discover any `.mjs`
  exporting `checks` (in checks/) or `recipes` (in recipes/).
- For `sim`, walk `<project>/opensip-tools/sim/scenarios/` and
  `<project>/opensip-tools/sim/recipes/`.
- The existing `<project>/.opensip-tools/<domain>/` path becomes a
  deprecated fallback that prints a one-line migration notice.

`<project>/opensip-tools/.runtime/plugins/<domain>/node_modules/`
becomes the npm-installed plugin location, replacing
`~/.opensip-tools/<domain>/node_modules/`.

### Phase 3 — Language detection + `init` scaffolding

`packages/cli/src/commands/init.ts` gains:

1. **Language detection** — a small `detectLanguages(cwd)` helper that
   inspects file markers (Cargo.toml, pyproject.toml, etc.) and returns
   either a single language, multiple matched languages (ambiguous), or
   none.
2. **`--language` flag** on the Commander definition (comma-separated;
   accepts any of typescript, rust, python, go, java, cpp).
3. **Detection-ambiguous prompt** — when `--language` is missing AND
   detection finds multiple/no markers, exit 2 with the prompt message
   shown above. No partial scaffolding.
4. **Scaffold operations**:
   - Render `opensip-tools.config.yml` from a per-language template
     (or polyglot template that emits one target per language).
   - `mkdir -p opensip-tools/{fit/{checks,recipes},sim/{scenarios,recipes}}`
   - Write the four `example-*.mjs` files with the resolved language(s)
     baked into `scope.languages`.
   - Append `opensip-tools/.runtime/` to `.gitignore` (create
     `.gitignore` if missing).
   - For polyglot init, emit one example check per language plus a
     single recipe that references all of them.
5. **Idempotence** — if `opensip-tools.config.yml` already exists,
   refuse to overwrite without `--force`. Same for example files.

### Phase 4 — `migrate` command + auto-migration

New file `packages/cli/src/commands/migrate.ts`. Detects v2 state by
checking for any of:
- `<project>/.opensip-tools/` directory presence
- `~/.opensip-tools/sessions/` non-empty
- gate baseline at `<project>/.opensip-tools/baseline.sarif`

The CLI's preAction hook invokes a silent auto-migration if v2 state
detected AND no `<project>/opensip-tools/.runtime/migrated-from-v2`
marker exists. Migration is idempotent.

The migration sorts each `*.mjs` file into the right v3 subdir by
inspecting its exports — files exporting `checks` go to `fit/checks/`
or get classified by their declared kind, files exporting `recipes`
go to `recipes/`, files exporting `scenarios` go to `sim/scenarios/`.
Files that export multiple kinds get copied to each appropriate
subdir; the original file is deleted only after every export is
re-homed.

### Phase 5 — Documentation

Update README, CLAUDE.md, CONTRIBUTING.md, and the smoke-test doc to
reflect v3 paths and the language-detection init flow. Add a v3.0.0
CHANGELOG entry with a worked migration example. The auto-migration
notice itself is high-quality docs: a user sees it once, learns the
new layout, never sees it again.

## Definition of done

1. `opensip-tools init` in a fresh Rust directory (just `Cargo.toml`)
   detects rust, scaffolds the v3 layout with `scope.languages: ['rust']`
   on the example check, and adds the `.gitignore` entry.
2. `opensip-tools init --language rust,typescript` in an empty
   directory scaffolds two targets and two language-scoped example
   checks plus a recipe referencing both.
3. `opensip-tools init` in a polyglot project without `--language`
   exits 2 with the disambiguation prompt — no partial scaffolding.
4. `opensip-tools fit --recipe example` after init runs the example
   check and reports a Pass.
5. `opensip-tools sim --recipe example` after init runs the example
   scenario and reports a Pass.
6. Auto-migration of a v2 project (DART) preserves all parity — same
   check count, same findings, same baseline behavior. Old
   `.opensip-tools/` files end up in the right `opensip-tools/<tool>/<subdir>/`.
7. `~/.opensip-tools/` after migration contains only `config.yml`.
8. All gates green: build, typecheck, test, lint (ESLint +
   dependency-cruiser), knip.
9. CHANGELOG documents the breaking change with a worked migration
   example.

## Estimated time

- Phase 0: 3 hours (sim recipes framework: types, registry, service,
  built-in default, CLI flag wiring, tests)
- Phase 1: 2 hours (path resolver + ~15 callsite updates)
- Phase 2: 1.5 hours (plugin loader behavior change for the new
  `<tool>/{checks,recipes,scenarios}/` subdir layout + tests)
- Phase 3: 1.5 hours (language detection + scaffolding templates per
  language; polyglot template)
- Phase 4: 2.5 hours (migrate command + auto-migration with
  exports-based file classification)
- Phase 5: 1 hour (docs)

Total: ~11-12 hours. Larger than v2 because we're building sim recipes
as part of the same release, plus per-language templates and the
exports-based migration sorter.

## Resolved decisions

These were settled during planning:

- **Visible `opensip-tools/` directory for user-authored content.**
  Custom checks, scenarios, and recipes are source code. They live in
  a tracked, visible directory next to the user's other source.
- **Hidden `.runtime/` subdir for tool state.** Sessions, logs,
  reports, baselines, AST cache, and npm-installed plugins all live
  under `opensip-tools/.runtime/` and are gitignored. Single top-level
  entry per project for everything opensip-tools-related.
- **`~/.opensip-tools/` retains only `config.yml`** (cloud API key,
  user-level identity). Everything else moves per-project.
- **Init scaffolds `example-*` files**, not `default.*`. Avoids
  collision with the framework's built-in `default` recipe; the name
  signals "you can delete this once you have your own."
- **Auto-load by directory presence**, no config opt-in needed.
  `opensip-tools/fit/checks/*.mjs` is loaded automatically; the config
  declaration is reserved for npm-package plugin pinning.
- **Project-local plugin install** (`opensip-tools/.runtime/plugins/`)
  instead of user-global. `--user` flag retains v2 behavior for the
  rare case it's wanted.
- **Auto-migration on first run, silent except for a one-line notice.**
  `opensip-tools migrate --dry-run` available for the cautious.
  Migration is reversible (file moves, no deletions until copies are
  verified).
- **`opensip-tools/<tool>/{checks,recipes,scenarios}/` subdirs** for
  the user-source layout. Conceptual clarity, mirrors framework types.
- **`init --language <comma-separated>`** with detection-then-prompt
  fallback. No silent defaulting.
- **v3.0.0 semver bump.** Plugin-loading semantics flip; plugin
  install location moves; users need to migrate. v3 not v2.1.

## Open questions

All resolved. Ready for execution.
