---
status: current
last_verified: 2026-05-15
title: "Contract surfaces"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The system's public edges. Every contract opensip-tools makes with the outside world, and what changing each one would cost."
source-files:
  - packages/contracts/src/types.ts
  - packages/contracts/src/exit-codes.ts
  - packages/core/src/tools/types.ts
  - packages/core/src/plugins/types.ts
  - packages/core/src/languages/adapter.ts
  - packages/fitness/engine/src/sarif.ts
related-docs:
  - ./01-fitness-loop.md
  - ./02-tool-plugin-model.md
  - ../70-reference/03-json-output-schema.md
---
# Contract surfaces

A contract is a promise to a consumer outside your control. Break it, and the consumer breaks. opensip-tools has six contract surfaces. Knowing what they are tells you what you can change freely (everything else) and what's expensive to change (these).

> **What you'll understand after this:**
> - The six surfaces opensip-tools commits to.
> - Who consumes each one.
> - The stability tier each surface sits at.
> - The shape and rationale of each.

---

## The six surfaces

| # | Surface | Consumers | Stability tier | Shape lives in |
|---|---|---|---|---|
| 1 | CLI argv (commands and flags) | humans, CI, shells | **stable** (semver-major) | `packages/*/src/*tool.ts` |
| 2 | Exit codes | CI, scripts | **stable** (semver-major) | `packages/contracts/src/exit-codes.ts` |
| 3 | JSON output (`CliOutput`) | CI, dashboards, the gate, OpenSIP Cloud | **stable** (semver-major) | `packages/contracts/src/types.ts` |
| 4 | SARIF output | GitHub Code Scanning, IDEs | **stable** (versioned by SARIF spec) | `packages/fitness/engine/src/sarif.ts` |
| 5 | Tool plugin contract (`Tool`) | third-party tools | **stable** (semver-major) | `packages/core/src/tools/types.ts` |
| 6 | Plugin discovery (Tool marker + check-pack name prefix) | third-party tools, check packs | **stable** (semver-major) | `packages/core/src/plugins/tool-package-discovery.ts`, `packages/fitness/engine/src/plugins/check-package-discovery.ts` |

Anything else — internal types, framework helpers, the recipe registry shape, the language-adapter content-filter API — is **internal**. It can move between minors. Don't depend on it from outside the workspace; if you do, you're on your own when it shifts.

---

## 1. CLI argv

The command tree and flag surface. What `opensip-tools --help` shows.

```
opensip-tools
├── fit                    (run fitness checks)
│   ├── --recipe <name>
│   ├── --check <slug>
│   ├── --tags <list>
│   ├── --json
│   ├── --findings
│   ├── --gate-save
│   ├── --gate-compare
│   ├── --baseline <path>
│   └── … (see fit-list, fit-recipes for catalogs)
├── sim                    (run simulation scenarios — experimental)
├── init                   (scaffold the project)
├── dashboard              (open the HTML report)
├── sessions
│   ├── list
│   └── purge
├── plugin
│   ├── list
│   ├── add <pkg>
│   ├── remove <pkg>
│   └── sync
├── configure              (cloud API key)
├── completion             (shell completion script)
├── uninstall              (remove ~/.opensip-tools/)
├── fit-list               (alias: list-checks)
└── fit-recipes            (alias: list-recipes)
```

Each command's flag list is owned by the Tool that registers it. `fit` flags live in [`packages/fitness/engine/src/tool.ts`](../../../packages/fitness/engine/src/tool.ts); `sim` flags in [`packages/simulation/engine/src/tool.ts`](../../../packages/simulation/engine/src/tool.ts); top-level commands like `init`, `plugin`, and `configure` live in [`packages/cli/src/commands/`](../../../packages/cli/src/commands/).

**Stability rule.** Removing a flag, removing a command, or changing a default value is a major-version change. Adding a flag with a safe default is a minor. Renaming a flag with an alias for the old name (the way `fit-list` aliases `list-checks`) is a minor; renaming without an alias is a major.

---

## 2. Exit codes

The integer the binary returns when it ends. Defined exactly once in [`packages/contracts/src/exit-codes.ts`](../../../packages/contracts/src/exit-codes.ts):

| Code | Constant | Meaning |
|---|---|---|
| `0` | `SUCCESS` | Run completed; no failing checks. |
| `1` | `RUNTIME_ERROR` | Run completed; checks failed (violations found). |
| `2` | `CONFIGURATION_ERROR` | Run could not start (config invalid, plugin failed to load, baseline missing). |

CI integrations are the primary consumer. `opensip-tools fit && deploy` is an idiom; so is `opensip-tools fit --gate-compare || (echo "regression" && exit 1)`.

**Stability rule.** Adding new codes is a major change (consumers are entitled to assume `0/1/2` is the universe). Re-purposing an existing code is a major change. The convention is "0 = green, 1 = red but expected, 2 = red and unexpected" — anything that breaks that mental model breaks consumers.

---

## 3. JSON output (`CliOutput`)

The structured stdout when `--json` is set. Shape lives at [`packages/contracts/src/types.ts`](../../../packages/contracts/src/types.ts):

```ts
interface CliOutput {
  readonly version: '1.0';
  readonly tool: 'fit' | 'sim';
  readonly timestamp: string;            // ISO 8601
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: { total: number; passed: number; failed: number; errors: number; warnings: number };
  readonly checks: readonly CheckOutput[];
  readonly durationMs: number;
}

interface CheckOutput {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly FindingOutput[];
  readonly durationMs: number;
}

interface FindingOutput {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}
```

The `version: '1.0'` discriminator is part of the contract. A future minor can add fields; a major can change `version` to `'2.0'` and break old consumers.

The full per-field reference (when each field is present, what each value can be) is in [`70-reference/03-json-output-schema.md`](../70-reference/03-json-output-schema.md).

**Stability rule.** Adding optional fields is a minor change. Adding required fields, removing fields, or changing types is a major change. Reordering keys within objects is *not* part of the contract — consumers must parse, not pattern-match — but in practice the renderer emits keys in declared order.

---

## 4. SARIF output

When `--gate-save` runs, the baseline is a SARIF 2.1.0 document built by [`packages/fitness/engine/src/sarif.ts`](../../../packages/fitness/engine/src/sarif.ts). The shape is the SARIF spec's, not ours — opensip-tools commits to producing valid SARIF 2.1.0, not to a custom shape. Consumers (GitHub Code Scanning, VS Code SARIF Viewer, custom CI tooling) can read these files with any SARIF parser.

**Stability rule.** The fields opensip-tools fills in are: `runs[].tool.driver.name = 'opensip-tools'`, `runs[].results[]` carrying `ruleId`, `message.text`, `level`, and `locations[].physicalLocation.{artifactLocation, region}`. Future versions may fill in more SARIF fields; we won't stop filling in those.

The gate's identity hash for diff matching is **not** SARIF-spec — it's an opensip-tools internal: `sha256(filePath + '\n' + ruleId + '\n' + message)`, deliberately excluding line numbers so unrelated line shifts don't register as added/resolved. See [`packages/fitness/engine/src/gate.ts:243`](../../../packages/fitness/engine/src/gate.ts) and [`50-subsystems/03-architecture-gate.md`](../50-subsystems/03-architecture-gate.md).

---

## 5. The Tool plugin contract

Discussed at length in [`02-tool-plugin-model.md`](./02-tool-plugin-model.md). The interface lives at [`packages/core/src/tools/types.ts`](../../../packages/core/src/tools/types.ts):

```ts
interface Tool {
  readonly metadata: ToolMetadata;
  readonly commands: readonly ToolCommandDescriptor[];
  readonly register: (cli: ToolCliContext) => void;
  readonly initialize?: () => Promise<void>;
}
```

Plus the `ToolCliContext` injected when the CLI calls `register()`.

**Stability rule.** Adding optional fields to `Tool` (like `initialize?`) is a minor change. Adding required fields is a major. Adding methods to `ToolCliContext` is a minor (existing tools won't call them); removing or renaming methods is a major.

Why this surface is so narrow: every byte of it is a constraint on every Tool author for the lifetime of the contract. The five-field shape is the smallest viable Tool API. If you find yourself wanting a sixth, ask whether it's really a Tool concern or a CLI-side helper.

---

## 6. Plugin discovery

opensip-tools discovers third-party packages two different ways depending on what you're shipping:

### Tools — explicit marker in `package.json`

```json
{
  "name": "@yourorg/your-tool",
  "main": "dist/index.js",
  "opensipTools": { "kind": "tool" }
}
```

The kernel's [`discoverToolPackages`](../../../packages/core/src/plugins/tool-package-discovery.ts) walks `node_modules` looking for the `opensipTools.kind === 'tool'` marker. The package's main entry must export a `tool: Tool` symbol.

### Check packs — name-prefix discovery

```json
{
  "name": "@opensip-tools/checks-mything",
  "main": "dist/index.js"
}
```

The fitness engine's [`discoverCheckPackages`](../../../packages/fitness/engine/src/plugins/check-package-discovery.ts) walks `node_modules` looking for any package whose name matches `@opensip-tools/checks-*`. **No `opensipTools.kind` marker is required** — the name prefix is the contract. The package's main entry must export `checks: Check[]`, optionally `recipes: FitnessRecipe[]`, and optionally `checkDisplay: Record<string, [icon, name]>`.

For names outside the `@opensip-tools/checks-*` prefix (e.g. an internal scope), declare the package explicitly in the project config:

```yaml
plugins:
  checkPackages:
    - '@my-org/fitness-checks'      # explicit pin disables auto-discovery
```

When `plugins.checkPackages:` is set, **only** those packages load — the `@opensip-tools/checks-*` auto-discovery is disabled for the run.

### Sim scenario packs

Currently use the same project-pinned shape as fit (declare the package in `plugins.sim:` in the project config and `plugin add` it). There is no name-prefix auto-discovery for sim today.

### Stability rules

- **Adding a new auto-discovery shape is a minor change.** Existing packs don't break.
- **Changing what an existing shape requires is a major change.** A pack at `@opensip-tools/checks-*` that exports `checks: Check[]` should keep working across minors.
- **The Tool marker (`opensipTools.kind: 'tool'`) is a stable surface.** A future fifth kind would be a deliberate addition, not an accident.

The `PluginDomain` type ([`packages/core/src/plugins/types.ts:91`](../../../packages/core/src/plugins/types.ts)) lists `'fit' | 'sim' | 'asm' | 'lang'` — these are domain identifiers used for path resolution (`<project>/opensip-tools/.runtime/plugins/<domain>/`), not `package.json` `kind` values. `asm` is reserved for a future tool.

---

## What's *not* a contract

It's worth being explicit about what isn't promised:

- **Internal framework types.** `CheckConfig`, `FitnessRecipe`, `RecipeCheckResult`, `ExecutionContext`, `PathMatcher` — all internal. They live in `@opensip-tools/fitness`, but they're not re-exported as part of the marketplace shape. Check packs use `defineCheck`/`defineRecipe` (which *are* stable) and never touch these.
- **Logger output format.** Logs are JSON Lines, but the field set is internal. Don't grep production logs for specific keys; treat them as opaque.
- **Cache file format.** The AST cache, the glob cache, the prewarm cache — all rebuildable. They have on-disk shapes, but those shapes change without notice. Wiping `<project>/opensip-tools/.runtime/cache/` is always safe.
- **Session record format.** Sessions are written to `<project>/opensip-tools/.runtime/sessions/<run-id>.json`, but the shape is internal. The `sessions list` command is the supported reader.
- **OpenSIP Cloud API.** The cloud is a separate product. Its API is its own contract, not opensip-tools'. The CLI POSTs `CliOutput` (which *is* stable), and the cloud is responsible for ingesting it.

---

## What this means for you

If you write a tool, a check pack, or a CI integration:

- **Lean on the six surfaces above.** Anything in this doc is safe to depend on. Read the linked source files for the precise shape.
- **Don't import internal types.** If you find yourself wanting `import { CheckConfig } from '@opensip-tools/fitness'`, take a step back — that import will move under your feet. Use `defineCheck()` instead, or open an issue to expose what you need as a stable surface.
- **Pin to majors.** `peerDependencies: { "@opensip-tools/core": "^1.0.0" }` is the right shape. Patch and minor are safe; major is a deliberate migration.
- **Test against `--json`, not against the table renderer.** The table renderer is for humans; the JSON output is the contract. Your CI integration parses JSON.

---

## What's next

You've now seen the four mental-model docs:

1. [`01-fitness-loop.md`](./01-fitness-loop.md) — the spine, eight stages.
2. [`02-tool-plugin-model.md`](./02-tool-plugin-model.md) — how the CLI doesn't know what `fit` does.
3. [`03-modular-monolith.md`](./03-modular-monolith.md) — five layers, 18 packages.
4. This doc — the public edges.

Time to go deeper. Section [`20-the-fit-loop/`](../20-the-fit-loop/) expands stages 4–8 of the loop with full code paths. Section [`30-the-sim-loop/`](../30-the-sim-loop/) does the same for `sim`. Sections 40+ cover runtime mechanics, subsystems, surfaces, reference, and conventions.
