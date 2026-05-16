---
status: draft
last_verified: 2026-05-15
title: "graph Tool — design spec"
audience: [contributors, plugin-authors]
purpose: "Implementation spec for @opensip-tools/graph, a code-path graph + dead-end detector. TypeScript-first."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/lib/paths.ts
  - packages/fitness/engine/src/tool.ts
  - packages/fitness/engine/package.json
  - packages/languages/lang-typescript/src/query.ts
  - packages/languages/lang-typescript/src/parse.ts
  - packages/cli/src/index.ts
  - packages/contracts/src/types.ts
  - .dependency-cruiser.cjs
related-docs:
  - ../architecture/10-mental-model/02-tool-plugin-model.md
  - ../architecture/10-mental-model/03-modular-monolith.md
  - ../architecture/60-surfaces/02-plugin-authoring.md
---
# `graph` Tool — design spec

A third Tool for opensip-tools: code-path graph + dead-end detector. TypeScript-first. Built on top of the same Tool contract that `fit` and `sim` use; produces `Signal[]` so the existing renderer/dashboard/gate work without changes.

This doc is the implementation spec — not the marketing pitch. Conceptual design (catalog schema, side-effect taxonomy, the four dead-end rules, hybrid id format) was done in a prior session and is summarized in [Appendix A](#appendix-a--conceptual-design-recap). What follows is the part a coder agent needs to actually build the package.

> **What you'll know after this:** the package shape, the catalog cache contract, the polymorphic-dispatch resolver behavior, and where every component sits in the existing architecture.

---

## 1. Package shape

### 1.0 Naming

The Tool id, package name, and CLI subcommand are all `graph`. No three-letter abbreviation. The existing pattern (`fitness` → `fit`, `simulation` → `sim`) abbreviates because the full names are long enough to slow typing; `graph` is already five letters. Inventing `gph`/`grp` would create a name nobody recognizes. Stay with `graph` — discoverable, fast enough to type, and code-readable in its full form.

The corresponding cell in the tool-name table:

| Tool id | Package | Subcommand |
|---|---|---|
| `fitness` | `@opensip-tools/fitness` | `fit` |
| `simulation` | `@opensip-tools/simulation` | `sim` |
| `graph` | `@opensip-tools/graph` | `graph` |

### 1.1 Layer placement

The new package sits at **Layer 3** (peer with `@opensip-tools/fitness` and `@opensip-tools/simulation`). It implements the `Tool` contract from [`packages/core/src/tools/types.ts`](../../packages/core/src/tools/types.ts) and mounts its commands via `register(cli)`. The dep-cruiser layer rules at [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) enforce:

- `graph` depends on `core`, `contracts`, and (for TS-AST work) `lang-typescript`.
- `graph` does **not** depend on `cli` (would create a cycle — `cli` will depend on `graph` once it's wired in).
- `graph` does **not** depend on `fitness` or `simulation` — peer Tools never reach across.

A new dep-cruiser rule mirrors the existing `fitness-no-cli` / `simulation-no-cli` pair:

```js
{
  name: 'graph-no-cli',
  severity: 'error',
  comment:
    'Tool packages must not depend on the CLI entry point. Use the ' +
    'ToolCliContext from @opensip-tools/core to call back into render / ' +
    'maybeOpenDashboard.',
  from: { path: '^packages/graph/' },
  to: { path: '^@opensip-tools/cli($|/)' },
}
```

Add it to `.dependency-cruiser.cjs` alongside the existing tool-no-cli rules.

### 1.2 Workspace location

```
packages/graph/engine/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts              # public API barrel
│   ├── tool.ts               # graphTool: Tool implementation
│   ├── cli/
│   │   ├── graph.ts          # main `graph` action handler
│   │   ├── entry-points.ts   # `graph entry-points` subcommand
│   │   └── orphans.ts        # `graph orphans` subcommand
│   ├── catalog/
│   │   ├── builder.ts        # parse pass → FunctionNode[] + FileNode[]
│   │   ├── resolver.ts       # uses ts.TypeChecker for symbol resolution
│   │   ├── index-builder.ts  # builds CatalogIndex from FunctionNode[]
│   │   ├── cache.ts          # read/write the on-disk catalog cache
│   │   └── types.ts          # FunctionNode, FileNode, CatalogIndex, CallSite
│   ├── analysis/
│   │   ├── entry-points.ts   # entry-point heuristic chain
│   │   ├── side-effects.ts   # the 8-kind taxonomy + detector
│   │   ├── transitive.ts     # graph traversal helpers
│   │   └── rules/
│   │       ├── orphan-subtree.ts
│   │       ├── test-only-reachable.ts
│   │       ├── no-side-effect-path.ts
│   │       ├── always-throws-branch.ts
│   │       └── duplicated-function-body.ts
│   ├── gate.ts               # graph --gate-save / --gate-compare (mirrors fitness/gate.ts)
│   └── __tests__/
└── README.md
```

The `engine/` subdirectory mirrors `fitness/engine/` and `simulation/engine/`. This leaves room for future `packages/graph/visualizer/` or `packages/graph/checks-graph-*` siblings without restructuring.

### 1.3 `package.json`

Modeled on `packages/fitness/engine/package.json` with the same shape and quality gates:

```json
{
  "name": "@opensip-tools/graph",
  "version": "1.0.4",
  "license": "MIT",
  "description": "Code-path graph + dead-end detector for OpenSIP Tools (TypeScript-first)",
  "repository": {
    "type": "git",
    "url": "https://github.com/opensip-ai/opensip-tools.git",
    "directory": "packages/graph/engine"
  },
  "homepage": "https://github.com/opensip-ai/opensip-tools",
  "bugs": { "url": "https://github.com/opensip-ai/opensip-tools/issues" },
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "opensipTools": { "kind": "tool" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@opensip-tools/contracts": "workspace:*",
    "@opensip-tools/core": "workspace:*",
    "@opensip-tools/lang-typescript": "workspace:*",
    "commander": "^13.1.0",
    "glob": "^11.0.0",
    "typescript": "~5.7.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0"
  }
}
```

Note the **direct dep on `@opensip-tools/lang-typescript`**. This is a peer-to-peer Layer 3 edge — like the documented `lang-typescript → fitness` exception in [`.dependency-cruiser.cjs:171`](../../.dependency-cruiser.cjs). It's the same shape, justified the same way: the graph tool needs `ts.SourceFile` parsing and the existing `parse.ts` is the source of truth. Add a dep-cruiser exception:

```js
{
  name: 'graph-typescript-only-on-lang-typescript',
  severity: 'error',
  comment:
    'graph depends on lang-typescript by design (TS-first scope). ' +
    'It must not depend on any other lang-* pack — adding multi-language ' +
    'support is a deliberate scope expansion that should be reviewed.',
  from: { path: '^packages/graph/' },
  to: {
    path: [
      '^@opensip-tools/lang-rust',
      '^@opensip-tools/lang-python',
      '^@opensip-tools/lang-go',
      '^@opensip-tools/lang-java',
      '^@opensip-tools/lang-cpp',
    ],
  },
}
```

### 1.4 The Tool implementation

[`src/tool.ts`](#) follows the pattern at [`packages/fitness/engine/src/tool.ts`](../../packages/fitness/engine/src/tool.ts):

```ts
import { EXIT_CODES } from '@opensip-tools/contracts';
import { type Command } from 'commander';

import { executeGraph } from './cli/graph.js';
import { executeEntryPoints } from './cli/entry-points.js';
import { executeOrphans } from './cli/orphans.js';
import {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GraphBaselineMissingError,
  GraphBaselineInvalidError,
  DEFAULT_GRAPH_BASELINE_PATH,
} from './gate.js';

import type { CliArgs, ToolOptions } from '@opensip-tools/contracts';
import type { Tool, ToolCliContext, ToolCommandDescriptor } from '@opensip-tools/core';

const GRAPH: ToolCommandDescriptor = {
  name: 'graph',
  description: 'Build the code-path graph and emit dead-end Signals',
};
const GRAPH_ENTRY_POINTS: ToolCommandDescriptor = {
  name: 'graph-entry-points',
  description: 'List inferred entry points discovered by the graph tool',
  aliases: ['entry-points'],
};
const GRAPH_ORPHANS: ToolCommandDescriptor = {
  name: 'graph-orphans',
  description: 'List orphan subtrees (the deletable slices)',
  aliases: ['orphans'],
};

function register(cli: ToolCliContext): void {
  const program = cli.program as Command;

  // graph [--gate-save | --gate-compare] [--baseline <path>]
  program.command(GRAPH.name)
    .description(GRAPH.description)
    .option('--cwd <path>', 'Target directory', process.cwd())
    .option('--config <path>', 'Path to opensip-tools.config.yml')
    .option('--json', 'Output structured JSON', false)
    .option('-v, --verbose', 'Show per-rule reasoning inline', false)
    .option('--gate-save', 'Save current findings as graph baseline', false)
    .option('--gate-compare', 'Compare current findings against baseline; exit 1 on regression', false)
    .option('--baseline <path>', 'Baseline file path (default: opensip-tools/.runtime/graph-baseline.sarif)')
    .option('--no-cache', 'Skip the catalog cache; rebuild from scratch', false)
    .option('--debug', 'Enable debug-level structured logs', false)
    .action(async (opts) => { /* dispatch on gate flags, JSON, Ink, etc. */ });

  // graph entry-points (alias of graph-entry-points)
  // graph orphans (alias of graph-orphans)
  // ... wired the same way fitness wires fit-list / fit-recipes
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: '1.0.4',
    description: 'Code-path graph + dead-end detector (TypeScript)',
  },
  commands: [GRAPH, GRAPH_ENTRY_POINTS, GRAPH_ORPHANS],
  register,
};
```

### 1.5 CLI registration

The CLI's static-import block at [`packages/cli/src/index.ts`](../../packages/cli/src/index.ts) needs one line added:

```ts
// existing:
import { fitnessTool } from '@opensip-tools/fitness';
import { simulationTool } from '@opensip-tools/simulation';
// new:
import { graphTool } from '@opensip-tools/graph';

defaultToolRegistry.register(fitnessTool);
defaultToolRegistry.register(simulationTool);
defaultToolRegistry.register(graphTool);  // new
```

The CLI's `package.json` needs `@opensip-tools/graph: workspace:*` added to `dependencies`.

### 1.6 Subcommand surface

| Command | Purpose | Output |
|---|---|---|
| `opensip-tools graph` | Build catalog + emit all rule Signals | Table (default) or JSON (`--json`) |
| `opensip-tools graph --gate-save` | Save findings as baseline | Stdout: `Baseline saved to <path>` |
| `opensip-tools graph --gate-compare` | Diff against baseline; exit 1 on regression | Structured diff like `fit --gate-compare` |
| `opensip-tools graph entry-points` | List inferred entry points only (no rule analysis) | Table or JSON |
| `opensip-tools graph orphans` | List orphan subtrees (the deletable slices) | Table or JSON |

The aliases (`entry-points`, `orphans`) mirror `fit-list` / `list-checks`. The full forms (`graph-entry-points`, `graph-orphans`) appear in `--help` so users discover the namespace.

### 1.7 PathDomain extension

[`packages/core/src/lib/paths.ts:75`](../../packages/core/src/lib/paths.ts) defines:

```ts
export type PathDomain = 'fit' | 'sim';
```

Adding `'graph'` is a breaking change to `core` — but a backwards-compatible one if the runtime dirs are accessed lazily (which they currently are: `pluginsDir(domain)` is a function call, not eager construction). Update to:

```ts
export type PathDomain = 'fit' | 'sim' | 'graph';
```

Plus update the `PluginsConfig` type in [`packages/fitness/engine/src/targets/types.ts`](../../packages/fitness/engine/src/targets/types.ts) to add a `graph?: readonly string[]` field for completeness (project-pinning support, even if graph doesn't have plugins on day one).

The plugin loader at [`packages/core/src/plugins/discover.ts:46-50`](../../packages/core/src/plugins/discover.ts) defines `USER_SUBDIRS` for fit and sim. Decide: does `graph` get user-source plugin loading (`<project>/opensip-tools/graph/checks/*.mjs`)? **For v1 of the tool: no.** Graph rules are built-in, not pluggable. The `USER_SUBDIRS` map stays unchanged. Re-evaluate once `graph` has shipped.

---

## 2. The catalog cache contract

The catalog is the durable artifact of the parse pass. It's the bulk of the work; everything downstream is graph queries against it. This section specs how it's stored, when it's invalidated, and how incremental rebuilds work.

### 2.1 Location

Per [`packages/core/src/lib/paths.ts`](../../packages/core/src/lib/paths.ts), every consumer reads paths through `resolveProjectPaths(cwd)`. Add a new field:

```ts
interface ProjectPaths {
  // ... existing fields ...
  /** <project>/opensip-tools/.runtime/cache/graph/ */
  readonly graphCacheDir: string;
  /** <project>/opensip-tools/.runtime/cache/graph/catalog.json */
  readonly graphCatalogPath: string;
  /** <project>/opensip-tools/.runtime/graph-baseline.sarif (default gate baseline). */
  readonly graphBaselinePath: string;
}
```

Resolved as:

```ts
graphCacheDir: join(runtimeDir, 'cache', 'graph'),
graphCatalogPath: join(runtimeDir, 'cache', 'graph', 'catalog.json'),
graphBaselinePath: join(runtimeDir, 'graph-baseline.sarif'),
```

The cache lives under `cache/graph/` (sibling to the fitness AST cache at `cache/ast/` and glob cache at `cache/glob/`). The baseline lives under `.runtime/` directly, not under `cache/` — same convention as `baseline.sarif` for fitness (see [`paths.ts:62`](../../packages/core/src/lib/paths.ts)).

### 2.2 Catalog file format

```json
{
  "version": "1.0",
  "tool": "graph",
  "language": "typescript",
  "builtAt": "2026-05-15T10:30:00Z",
  "tsConfigPath": "/abs/path/to/tsconfig.json",
  "tsCompilerVersion": "5.7.2",
  "files": [
    {
      "path": "packages/core/src/lib/paths.ts",
      "contentHash": "sha256:a3f9...",
      "languageId": "typescript",
      "inTestPath": false,
      "imports": [
        { "specifier": "node:path", "resolvedPath": null, "imported": [{ "local": "join", "external": "join" }] }
      ],
      "definesFunctions": ["fn:e7c2f1a4@packages/core/src/lib/paths.ts#resolveProjectPaths"]
    }
  ],
  "functions": [
    {
      "id": "fn:e7c2f1a4@packages/core/src/lib/paths.ts#resolveProjectPaths",
      "qualifiedName": "core/lib/paths.resolveProjectPaths",
      "simpleName": "resolveProjectPaths",
      "filePath": "packages/core/src/lib/paths.ts",
      "line": 78, "column": 1, "endLine": 97,
      "kind": "function",
      "params": [{ "name": "projectDir", "optional": false, "rest": false }],
      "returnType": "ProjectPaths",
      "exportedFrom": "packages/core/src/lib/paths.ts",
      "visibility": "exported",
      "decorators": [],
      "directSideEffects": [],
      "inTestFile": false,
      "definedInGenerated": false,
      "calls": [
        {
          "line": 79, "column": 24,
          "resolvedTo": ["fn:b2c8d31e@node_modules/typescript/lib/lib.es5.d.ts#join"],
          "resolution": "static",
          "confidence": "high",
          "text": "join(projectDir, 'opensip-tools')"
        }
      ]
    }
  ],
  "indexes": {
    "byContentHash": {
      "sha256:a3f9...": ["fn:e7c2f1a4@..."]
    },
    "callers": {
      "fn:e7c2f1a4@packages/core/src/lib/paths.ts#resolveProjectPaths": ["fn:c4d2e1...#configurePersistencePaths"]
    }
  }
}
```

The exact `FunctionNode`, `FileNode`, `CallSite`, and `CatalogIndex` shapes are defined in [`src/catalog/types.ts`](#). The on-disk format mirrors the in-memory shape exactly — no schema transformation on serialize/deserialize.

The `version: '1.0'` discriminator opens the door to schema migrations later (a `version: '2.0'` catalog is rejected by a 1.0-aware parser).

### 2.3 Cache invalidation

The cache is **content-keyed**. The invalidation rules, in order:

1. **Whole-cache invalidation:**
   - `tsCompilerVersion` doesn't match the current TypeScript version. Cache is built against TS-AST; a TypeScript upgrade can change AST shapes.
   - `tsConfigPath` doesn't match the resolved tsconfig (changing tsconfig changes module resolution, which changes call-site resolution).
   - `version` doesn't match the current catalog schema version.
   - On any of these: discard cache, full rebuild.

2. **Per-file invalidation:**
   - For every file in the project: compute current `contentHash`.
   - If the hash matches a `FileNode` in the cache → reuse all `FunctionNode`s defined by that file.
   - If the hash differs → drop the file's `FunctionNode`s; re-parse and replace.
   - If a file is missing from the project but present in the cache → drop its `FunctionNode`s (file deleted).
   - If a file is in the project but not in the cache → parse and add.

3. **Index rebuild:**
   - The `byContentHash` and `callers` indexes are **rebuilt globally on every run** even if no files changed. They're cheap (linear in `FunctionNode` count) and any stale entry would silently break the orphan classification. Don't try to incrementally update them.

### 2.4 The incremental rebuild flow

```
loadCache(graphCatalogPath) → CatalogV1 | null
  ↓
validateWholeCache(catalog, currentTsVersion, currentTsConfig)
  ↓ (if invalid: catalog = null)
walkFiles(projectDir, tsConfig.include, tsConfig.exclude) → currentFiles
  ↓
for each file in currentFiles:
  contentHash = sha256(readFileSync(file))
  if (catalog?.files.has(file) && catalog.files[file].contentHash === contentHash):
    // reuse — copy FunctionNode[] from old catalog
  else:
    // re-parse — call catalogBuilder.parseFile(file)
  ↓
purgeDeleted(catalog, currentFiles)  // drop FunctionNodes from gone files
  ↓
buildIndexes(allFunctionNodes) → CatalogIndex  // global, every time
  ↓
saveCache(catalog, graphCatalogPath)
```

The `--no-cache` flag short-circuits step 1 and step 2 — parses every file fresh. Useful for debugging.

### 2.5 Cache size and rotation

The catalog is one JSON file. On a 50K-LOC TypeScript codebase it's typically 5–15MB. No rotation policy — the cache replaces itself every run. If the file grows pathologically large (some downstream-fan-out polymorphic dispatch expanding `resolvedTo` arrays), that's a real signal worth investigating, not a feature to limit.

The cache file is gitignored as a member of `.runtime/`. No accidental commits.

### 2.6 Concurrent runs

opensip-tools has no daemon; each run is a fresh process. But two `opensip-tools graph` runs in parallel against the same project would race on the cache file write. The implementation should:

- Read the cache once at startup; in-memory copy is per-process.
- Write the new cache atomically: `writeFileSync(tmpPath); rename(tmpPath, catalogPath)`. POSIX rename is atomic; the second run reading mid-rename gets either the old or new file, never a torn write.

This is the same pattern fitness uses for the SARIF baseline at [`packages/fitness/engine/src/gate.ts`](../../packages/fitness/engine/src/gate.ts).

---

## 3. Polymorphic dispatch

The trickiest part of any call-graph tool. Walking through how it's resolved end-to-end on a concrete case.

### 3.1 The setup

Hypothetical TypeScript code:

```ts
// packages/foo/src/notifier.ts
export interface Notifier {
  notify(event: Event): void;
}

export class EmailNotifier implements Notifier {
  notify(event: Event): void { /* ... */ }
}

export class SlackNotifier implements Notifier {
  notify(event: Event): void { /* ... */ }
}

export class SmsNotifier implements Notifier {
  notify(event: Event): void { /* ... */ }
}

export class PagerNotifier implements Notifier {
  notify(event: Event): void { /* ... */ }
}

export class NoopNotifier implements Notifier {
  notify(event: Event): void { /* ... */ }
}

// packages/foo/src/dispatcher.ts
export function dispatchAlert(notifier: Notifier, event: Event): void {
  notifier.notify(event);  // ← polymorphic call site
}
```

At the `notifier.notify(event)` call site, the static type of `notifier` is `Notifier`. The TypeScript compiler can resolve this to the *interface method*, not to any specific implementation. The graph tool's resolver receives an interface symbol with five concrete implementations.

### 3.2 What the resolver records

[`src/catalog/resolver.ts`](#) uses `ts.TypeChecker.getSymbolAtLocation` and `ts.TypeChecker.getResolvedSignature` to walk the call site. The resolution flow:

```
1. callExpr = `notifier.notify(event)`
2. propAccess = callExpr.expression  (PropertyAccessExpression `notifier.notify`)
3. methodSymbol = checker.getSymbolAtLocation(propAccess.name)
   → Symbol for `Notifier.notify` (the interface method declaration)
4. methodDecls = methodSymbol.declarations
   → Array of all declarations of `notify`. For an interface method,
     this is the interface declaration itself.
5. To get implementations: walk the type system.
   typeOfReceiver = checker.getTypeAtLocation(propAccess.expression)  // notifier's type
   → Type for `Notifier` (the interface)

   For each class in the program implementing `Notifier`:
     classSymbol = ...
     methodDecl = classSymbol.members.get('notify')
     if methodDecl: collect methodDecl
   → 5 implementations: EmailNotifier.notify, SlackNotifier.notify,
                         SmsNotifier.notify, PagerNotifier.notify, NoopNotifier.notify
```

The implementation walk is a `ts.Program.getSourceFiles().forEach()` filtering for class declarations whose `heritageClauses` include the interface. This is O(classCount) per polymorphic call site — fine for typical projects.

The resolver records the call site as:

```json
{
  "line": 2, "column": 12,
  "resolvedTo": [
    "fn:e1@packages/foo/src/notifier.ts#EmailNotifier.notify",
    "fn:s1@packages/foo/src/notifier.ts#SlackNotifier.notify",
    "fn:s2@packages/foo/src/notifier.ts#SmsNotifier.notify",
    "fn:p1@packages/foo/src/notifier.ts#PagerNotifier.notify",
    "fn:n1@packages/foo/src/notifier.ts#NoopNotifier.notify"
  ],
  "resolution": "method-dispatch",
  "confidence": "medium",
  "text": "notifier.notify(event)"
}
```

Five `resolvedTo` ids. `resolution: 'method-dispatch'` (not `'static'`). `confidence: 'medium'` because the receiver's runtime type isn't statically knowable — the call site might dispatch to any of the five at runtime.

### 3.3 What the inverted index records

The `callers` index includes the polymorphic call site for **every** target:

```ts
callers["fn:e1@...#EmailNotifier.notify"]  = ["fn:d1@...#dispatchAlert"]
callers["fn:s1@...#SlackNotifier.notify"]  = ["fn:d1@...#dispatchAlert"]
callers["fn:s2@...#SmsNotifier.notify"]    = ["fn:d1@...#dispatchAlert"]
callers["fn:p1@...#PagerNotifier.notify"]  = ["fn:d1@...#dispatchAlert"]
callers["fn:n1@...#NoopNotifier.notify"]   = ["fn:d1@...#dispatchAlert"]
```

All five impls have `dispatchAlert` as a (potential) caller. The inverted index treats polymorphic dispatch as a *fan-in* of one source caller to N targets — same as if there were five separate calls.

### 3.4 How rules treat the multi-target call site

This is the load-bearing decision. The two ways to interpret polymorphic dispatch:

**Conservative** (treat all 5 as definitely called): a function in the polymorphic set has a real caller. Orphan rule won't fire.

**Liberal** (treat only the static type as called — i.e. only the interface method): only `Notifier.notify` is "called"; the 5 concrete impls have zero static callers.

opensip-tools' graph tool uses **conservative interpretation** for orphan analysis and **fan-out interpretation** for side-effect analysis. The rule-by-rule behavior:

#### `graph:orphan-subtree` (conservative)

If `EmailNotifier.notify` appears in any `callers` index entry — even as a polymorphic candidate — it is **not** an orphan. The reasoning: from a static-analysis perspective, we can't prove the runtime never reaches it. The rule's job is to find code that's structurally unreachable; a polymorphic candidate is reachable.

This means even `NoopNotifier.notify` (which might never actually be instantiated and used at runtime) is *not* an orphan, because it's referenced by the polymorphic dispatch.

The trade-off: false negatives (we miss real dead code where N-of-M implementations are never instantiated). The alternative — calling something an orphan when it has a polymorphic caller — would produce false positives (call dead code that's actually live). False negatives are recoverable by manual inspection; false positives cause real problems (engineers delete code that's used).

#### `graph:no-side-effect-path` (fan-out)

A function's transitive callees are computed by following **every** outgoing edge. For the polymorphic call site at `dispatchAlert`, that means walking into all 5 implementations.

`dispatchAlert`'s subtree includes:
- `EmailNotifier.notify` and everything *it* reaches
- `SlackNotifier.notify` and everything *it* reaches
- … and so on for the other three

If **any** of those subtrees has a side effect, `dispatchAlert`'s overall subtree has a side effect. The rule won't fire.

If **all five** subtrees are pure (none touch I/O, DB, log, throw), `dispatchAlert`'s subtree is pure and the rule fires. (In practice this is rare — at least one notification implementation almost always touches I/O.)

#### `graph:test-only-reachable` (conservative)

A function is "test-only reachable" iff every path from any inferred entry point to that function passes only through test files. For polymorphic dispatch: the rule is "every caller (including polymorphic candidates) is in a test path."

If `EmailNotifier.notify` is called by `dispatchAlert` (production code) AND `MockNotifier.notify` is registered for tests, neither one is "test-only" — `dispatchAlert` brings the production call path.

#### `graph:always-throws-branch` (per-function CFG)

Doesn't interact with polymorphism — operates within a single function's control-flow graph. Not affected.

#### `graph:duplicated-function-body` (content-hash join)

Doesn't interact with polymorphism. Two `notify` implementations with byte-identical bodies trip the rule (legitimately — they should share an implementation).

### 3.5 Confidence as the relief valve

The signal output for any rule firing on a function reachable through polymorphic dispatch should mark its **confidence as `medium`**, even if the rule's underlying logic is "high confidence."

The renderer surfaces this. A user inspecting `graph:no-side-effect-path` on `dispatchAlert` sees:

```
graph:no-side-effect-path  packages/foo/src/dispatcher.ts:1  dispatchAlert
    Function and its 5 transitive callees touch no I/O, DB, logs, or throws.
    Confidence: MEDIUM — some callees reached via polymorphic dispatch.
    Polymorphic dispatch sites in this subtree:
      packages/foo/src/dispatcher.ts:2 — notifier.notify (5 candidates)
```

The user can decide whether the rule's verdict is trustworthy given the polymorphic candidates.

### 3.6 What we don't try to handle

- **Runtime-determined callees.** `eventBus.emit('user.created')` looks like a string, not a call. The resolver records this as `resolution: 'dynamic-string'` with `confidence: 'low'` and an empty `resolvedTo`. Subsequent rules treat it as an unknown — they don't attempt to find functions named `userCreated` and assume those are reached.
- **Reflection.** `obj[methodName]()` where `methodName` is a runtime value. Same as above — `resolution: 'unknown'`, low confidence, no resolved targets.
- **Re-export chains.** `export { foo } from './a'; export { foo } from './b';` — the TS compiler's symbol table handles this for us; the resolver follows the chain to the original definition.
- **Type assertions stripping the type.** `(thing as any).foo()` discards the static type. Resolver records `resolution: 'unknown'`.

For all of these, the conservative answer is "treat as if it could reach anything" — which means the orphan rule won't false-positive on functions that *might* be reached via reflection, even though we can't prove they are.

---

## 4. Implementation order

A phased build path that keeps the package shippable at every milestone:

| Phase | What ships | New rule fires | Confidence |
|---|---|---|---|
| **P0 — Skeleton** | Package compiles, Tool registers, `graph` command runs and prints "no-op" | none | n/a |
| **P1 — Catalog (no resolver)** | Catalog builds; every call site is `resolution: 'unknown'`; no rules fire | none | n/a |
| **P2 — Static resolver** | TypeChecker-based resolution for direct calls (`foo()`); polymorphic still `unknown` | `graph:duplicated-function-body` (uses only contentHash) | high |
| **P3 — Polymorphic resolver** | `obj.method()` resolves to all impls; conservative orphan analysis | `graph:orphan-subtree` | high (no-poly) / medium (with-poly) |
| **P4 — Side-effect taxonomy** | 8-kind detector with default `node:*` heuristics + override config | `graph:no-side-effect-path` | medium |
| **P5 — Test-only analysis** | Walk `inTestFile` reachability | `graph:test-only-reachable` | high |
| **P6 — CFG always-throws** | Per-function control-flow graph for throw-branch detection | `graph:always-throws-branch` | high |
| **P7 — Gate + cache + CI** | Baseline workflow, cache invalidation, incremental rebuild | (regression detection on all rules) | n/a |

P0–P3 produces an MVP shippable as `@opensip-tools/graph@0.1.0` (pre-1.0 to flag the still-shifting API). P7 is what makes it `1.0`-quality.

---

## 5. What's deliberately out of scope

- **Other languages.** TS-only first cut. Adding Rust would require either a `rust-analyzer` subprocess integration or a hand-written Rust resolver — months of work.
- **Visualizer.** No interactive graph rendering. The output is `Signal[]`; the dashboard already groups by file and function. A real visualizer is a future feature.
- **Custom user-authored rules.** Like `fit`, the graph tool *could* support project-local checks under `<project>/opensip-tools/graph/checks/*.mjs`, but this is deferred. The five built-in rules are the v1 scope.
- **Cross-process catalog sharing.** No daemon. Each `opensip-tools graph` run reads the cache, computes its delta, and writes back. If teams want shared cache, that's a future LSP-mode feature.

---

## 6. Output paths and consumers

The graph tool produces output at five distinct surfaces. Each consumes the same in-memory `GraphRunResult` but serializes differently for its audience.

### 6.1 The five output forms

| Form | Command | Audience | Shape |
|---|---|---|---|
| Run summary | `graph` (default) | Human at terminal | Ink table — catalog stats + entry-point summary + finding rollup |
| Per-finding detail | `graph --findings` | Human investigating findings | Ink long-form — per-rule, per-finding, with reasoning trail |
| Structured JSON | `graph --json` | CI, dashboards, OpenSIP Cloud | `CliOutput` from `@opensip-tools/contracts` |
| Entry-points listing | `graph entry-points` | Onboarding / refactor sanity check | Table or JSON, no rule analysis |
| Orphan slice | `graph orphans` | Tech-debt cleanup | Table or JSON — deletable slices + verification recipe |

The default output keeps things scannable:

```
opensip-tools graph

Catalog: 312 functions, 47 files, 891 call sites resolved (47 unknown)
Entry points (12 inferred):
  ✓ packages/cli/src/index.ts:1                main (BinaryEntryHeuristic)
  ... (11 more)

Findings (8 errors, 5 warnings):
  ✗ graph:orphan-subtree                  3 occurrences
  ✗ graph:always-throws-branch            5 occurrences
  ⚠ graph:no-side-effect-path             4 occurrences
  ⚠ graph:test-only-reachable             1 occurrence
  ⚠ graph:duplicated-function-body        0 occurrences

13 findings | Duration 4.2s

Run `opensip-tools graph --findings` for details, or
    `opensip-tools graph orphans` for the deletable slice.
```

The `--findings` output adds, per finding: subtree members, reachable entry points, callees inspected (for `no-side-effect-path`), confidence level, and a `Hint:` line where applicable. The "callees inspected" trail is the audit trail — the user verifies the rule's reasoning without re-running the analysis.

### 6.2 Graph-specific data outside `CliOutput`

The graph tool produces two data classes that don't fit the per-finding `CliOutput` shape:

- **Catalog statistics** — function count, file count, resolved-vs-unknown call counts.
- **Entry-points listing** — the inferred entry points with their matched heuristics.

Two ways to handle this:

- **Embed in `CliOutput.metadata` per-finding** — pollutes the standard shape; consumers parsing one finding shouldn't need to filter out catalog totals.
- **Separate `graph metadata` subcommand** — clean separation; cataloging this data is a distinct user intent from "what regressed?"

**Decision:** separate `graph metadata` subcommand. `graph` and `graph --json` produce a clean `CliOutput`. Consumers who want catalog-level data run `graph metadata --json` separately:

```bash
opensip-tools graph                # findings only (CliOutput)
opensip-tools graph --json         # findings only (CliOutput JSON)
opensip-tools graph metadata --json  # catalog stats + entry points (graph-specific shape)
```

### 6.3 Signal `metadata` field convention

Per-finding metadata is the place for rule-specific data that doesn't fit `FindingOutput`'s top-level fields. Each rule populates its `metadata`:

| Rule | metadata fields |
|---|---|
| `graph:orphan-subtree` | `subtreeSize`, `subtreeLines`, `subtreeFunctions[]`, `confidence` |
| `graph:test-only-reachable` | `testFiles[]`, `productionAncestor` |
| `graph:no-side-effect-path` | `transitiveCalleeCount`, `calleesInspected[]`, `confidence` |
| `graph:always-throws-branch` | `branchLine`, `branchColumn`, `dominator` |
| `graph:duplicated-function-body` | `contentHash`, `duplicates[]` |

The `confidence` field is universal for graph signals — tracks high/medium/low per [§3.5](#35-confidence-as-the-relief-valve).

### 6.4 Worked example: orphan-subtree → CliOutput

The hypothetical `oldDedupAlgo` orphan from [Appendix A](#appendix-a--conceptual-design-recap), serialized:

```json
{
  "ruleId": "graph:orphan-subtree",
  "message": "Orphan subtree: 4 functions, 87 lines, 0 reachable entry points",
  "severity": "error",
  "filePath": "crates/dart-normalizer/src/dedup.rs",
  "line": 12,
  "metadata": {
    "subtreeSize": 4,
    "subtreeLines": 87,
    "subtreeFunctions": [
      "oldDedupAlgo",
      "normalizeForDedup",
      "legacyHashKey",
      "legacyKnownKey"
    ],
    "confidence": "high"
  }
}
```

Standard `FindingOutput` shape; nothing graph-specific at the top level. Consumers parsing `CliOutput` see this as a regular finding. The renderer (terminal or dashboard) reads `metadata` to surface the subtree detail.

---

## 7. Cloud reporting via SARIF

Graph signals integrate with OpenSIP Cloud the same way fit signals do — SARIF 2.1.0 over HTTP, via `--report-to`.

### 7.1 The infrastructure already exists

The fitness package's [`sarif.ts`](../../packages/fitness/engine/src/sarif.ts) provides `buildSarifLog(output: CliOutput)`, `chunkSarifRuns(runs, maxFindings)`, and `reportToCloud(output, url, apiKey)`. All three consume `CliOutput`. The graph tool already produces `CliOutput` per [§6](#6-output-paths-and-consumers). The integration is straightforward.

### 7.2 The flag

`graph` mounts the same `--report-to` and `--api-key` flags as `fit`:

```bash
opensip-tools graph --report-to https://opensip.ai/api
opensip-tools graph --report-to https://opensip.ai/api --api-key sk-...
```

Behavior matches fit's:
- Composable with other modes — `graph --json --report-to <url>` produces both stdout JSON and a cloud upload.
- Uses the configured key from `~/.opensip-tools/config.yml` if `--api-key` is absent.
- Posts SARIF in chunks of ≤500 findings each, with retry on transient failures and a chunk-size-scaled timeout.

### 7.3 Where the SARIF code lives

Two options were considered:

- **Option A — Extract `sarif.ts` to a shared `@opensip-tools/sarif` package.** Architecturally clean. Both fit and graph import from there. One extra package.
- **Option B — Inline `sarif.ts` in `@opensip-tools/graph` for v0.1, extract in a follow-up.** Faster first PR. Bounded duplication.

**Decision:** **B for v0.1, promote to A in a follow-up PR.** The shim is ~100 LOC of duplication. Extracting once both Tools' usage patterns are stable lets us see what the right shared shape is — extracting prematurely risks under-fitting one of the consumers.

The follow-up extraction PR moves three exports (`buildSarifLog`, `chunkSarifRuns`, `reportToCloud`) from `@opensip-tools/fitness` and the duplicate from `@opensip-tools/graph` into `@opensip-tools/sarif`. Updates two import lines per consumer. Adds the new package to the release workflow.

### 7.4 What the cloud receives

A graph SARIF document looks like a fit SARIF document with rule ids prefixed `graph:`:

```json
{
  "version": "2.1.0",
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
  "runs": [
    {
      "tool": { "driver": { "name": "orphan-subtree", "version": "1.0.0", "rules": [{ "id": "graph:orphan-subtree" }] } },
      "results": [
        {
          "ruleId": "graph:orphan-subtree",
          "message": { "text": "Orphan subtree: 4 functions, 87 lines, 0 reachable entry points" },
          "level": "error",
          "locations": [{
            "physicalLocation": {
              "artifactLocation": { "uri": "crates/dart-normalizer/src/dedup.rs" },
              "region": { "startLine": 12 }
            }
          }]
        }
      ]
    }
  ]
}
```

The graph-specific `metadata` from §6.3 is **not in the SARIF output** — SARIF doesn't have a standard slot for free-form per-finding metadata. Consumers who want the subtree detail use `CliOutput` JSON, not SARIF. SARIF is for cloud ingestion; JSON is for richer downstream tooling.

---

## 8. Data persistence

The graph tool produces three classes of on-disk data, each with its own home and lifetime.

### 8.1 The three artifacts

| Artifact | Path | Lifetime | Gitignored? |
|---|---|---|---|
| **Catalog cache** | `<project>/opensip-tools/.runtime/cache/graph/catalog.json` | Replaced atomically each run | Yes |
| **Session record** | `<project>/opensip-tools/.runtime/sessions/<timestamp>-graph-<recipe>.json` | Persists until `sessions purge` | Yes |
| **Gate baseline** | `<project>/opensip-tools/.runtime/graph-baseline.sarif` (default) | Until `--gate-save` overwrites | Default location is gitignored; teams can move it outside `.runtime/` to commit |

All three live under `.runtime/`. No new top-level dirs. The full layout becomes:

```
<project>/opensip-tools/.runtime/
├── cache/
│   ├── ast/                ← fitness AST cache (existing)
│   ├── glob/               ← fitness glob cache (existing)
│   └── graph/
│       └── catalog.json    ← NEW: graph catalog cache
├── sessions/<id>.json       ← extended: graph runs land here too
├── reports/<id>/index.html  ← extended: graph runs render here too
├── logs/<id>.jsonl
├── baseline.sarif           ← fitness gate baseline (existing)
└── graph-baseline.sarif     ← NEW: graph gate baseline
```

### 8.2 Path additions

Three new fields on `ProjectPaths` from [`packages/core/src/lib/paths.ts`](../../packages/core/src/lib/paths.ts):

```ts
interface ProjectPaths {
  // ... existing fields ...
  /** <runtime>/cache/graph */
  readonly graphCacheDir: string;
  /** <runtime>/cache/graph/catalog.json */
  readonly graphCatalogPath: string;
  /** <runtime>/graph-baseline.sarif (default gate baseline) */
  readonly graphBaselinePath: string;
}
```

Resolved as:

```ts
graphCacheDir: join(runtimeDir, 'cache', 'graph'),
graphCatalogPath: join(runtimeDir, 'cache', 'graph', 'catalog.json'),
graphBaselinePath: join(runtimeDir, 'graph-baseline.sarif'),
```

### 8.3 Why a separate gate baseline

Each tool has its own baseline. Sharing one file would mean a `fit --gate-compare` regression invalidates the graph baseline (and vice versa). Separate files = independent gates. Same convention as fit (`baseline.sarif`) and any future tool.

### 8.4 Session schema extension

`StoredSession.tool` from [`packages/contracts/src/persistence/store.ts`](../../packages/contracts/src/persistence/store.ts) is currently `'fit' | 'sim'`. Extend to `'fit' | 'sim' | 'graph'`. Same additive change as adding `'graph'` to `PathDomain` — non-breaking for consumers using `if`/`switch`-with-default.

The graph tool writes session records using the existing session writer (no new code) — the writer accepts a `CliOutput` and graph already produces one.

### 8.5 What can be safely deleted

| Path | Safe to delete? | Effect |
|---|---|---|
| `cache/graph/catalog.json` | yes | Next graph run rebuilds (slower first run after) |
| `sessions/<id>.json` (graph run) | yes | History entry disappears |
| `reports/<id>/` (graph run) | yes | Report disappears |
| `graph-baseline.sarif` | careful | Next `--gate-compare` errors with `GraphBaselineMissingError` |

The whole `<project>/opensip-tools/.runtime/` dir is also safe to delete. Authored content under `<project>/opensip-tools/{fit,sim}/` is untouched by graph.

---

## 9. Dashboard integration

The HTML dashboard at [`packages/contracts/src/persistence/dashboard/`](../../packages/contracts/src/persistence/dashboard/) needs to absorb graph runs alongside fit and sim runs. No new dashboard package; the contracts package owns the dashboard for all tools.

### 9.1 Tool-tabs extension

The current dashboard's tool-tabs switcher ([`tool-tabs.ts`](../../packages/contracts/src/persistence/dashboard/tool-tabs.ts)) toggles between fit and sim. Add a third tab: `graph`. Filters the four existing panels (Overview, Sessions, Checks, Recipes) by tool.

The change is small — extend the tab union from `'fit' | 'sim'` to `'fit' | 'sim' | 'graph'`, mirroring `StoredSession.tool` (§8.4). Existing panels read `session.tool` and filter; they continue to work for graph sessions with no per-panel changes.

### 9.2 New panel: Code Paths

Graph data is *structural* (current state of the codebase), not run-history-shaped. The four existing panels don't surface this well. Add a fifth panel, **Code Paths**, that surfaces graph-specific data.

Layout:

```
┌── Code Paths ──────────────────────────────────────────────────┐
│  [Last run: 2026-05-15 14:23]  [Refresh]                        │
│                                                                  │
│  📊 Catalog                                                      │
│  312 functions │ 47 files │ 891 calls (47 unknown)              │
│                                                                  │
│  🚪 Entry points (12)                          [view all →]     │
│  packages/cli/src/index.ts:1                main                │
│  packages/fitness/engine/src/cli/fit.ts:23  executeFit          │
│  ... (10 more)                                                  │
│                                                                  │
│  🌳 Orphan subtrees (3)                       [view all →]      │
│  packages/foo/src/legacy.rs:42 (4 funcs, 87 lines)              │
│  packages/dashboard/src/utils/oldFormatter.ts:15 (1 func, 12)   │
│  packages/cli/src/__tests__/fixtures/old-test.ts:8 (1 func, 6)  │
│                                                                  │
│  ⚠ Other findings                                               │
│  no-side-effect-path: 4   always-throws-branch: 5               │
│  test-only-reachable: 1   duplicated-function-body: 0           │
│                                                                  │
│  📈 Trend (last 10 runs)                                        │
│  Orphans:  5 5 5 4 4 4 3 3 3 3                                  │
│  Findings: 18 17 17 16 16 15 13 13 13 13                        │
└──────────────────────────────────────────────────────────────────┘
```

Five sub-sections: catalog stats, top N entry points, orphan subtrees, finding-count rollup for non-orphan rules, and a sparkline trend over the last 10 runs.

The data source: the most recent graph session record at `<project>/opensip-tools/.runtime/sessions/<id>.json` plus the catalog cache at `<project>/opensip-tools/.runtime/cache/graph/catalog.json`.

### 9.3 Graph-aware finding rendering

Existing fitness findings render with file path, line, severity, message. Graph findings have additional structure (subtree members, callees inspected, polymorphic dispatch info) the universal renderer doesn't show.

**Decision:** add a graph-aware finding renderer rather than extending the universal one. A switch on `ruleId.startsWith('graph:')` delegates to a graph-specific HTML template. The fitness renderer stays unchanged.

Adds ~50 LOC. Keeps rule-specific code out of the universal Signal renderer.

### 9.4 Why dashboard code stays in `contracts`

Two options were considered:

- **All dashboard code in `@opensip-tools/contracts`.** Existing pattern. Dashboard generator becomes aware of all three tools' data.
- **Per-tool dashboard panel plugins.** Each tool ships its own panel; dashboard discovers them via a registration mechanism.

**Decision:** keep dashboard code in `contracts` (option 1). The dashboard is *infrastructure shared by all tools*. We don't make every tool ship its own session storage; same logic for dashboard storage. A pluggable dashboard would be over-engineered for three tools. Adds ~600 LOC of new dashboard code in contracts plus ~100 LOC of changes to existing files.

### 9.5 Refresh model

Static. The dashboard generator reads session data at HTML-generation time. The user reruns `opensip-tools dashboard` (or runs `opensip-tools graph --open`) to pick up new sessions.

Auto-reload via `setInterval` and live-watch via file watchers were considered and rejected. Keep the dashboard fully self-contained — you can email the directory to a teammate; live-fetching breaks that property.

### 9.6 Files to add or change

| File | Change | Approx LOC |
|---|---|---|
| `tool-tabs.ts` | Extend tab union | +5 |
| `generator.ts` | Read graph data, compose new panel | +100 |
| `code-paths.ts` (new) | The Code Paths panel | +300 |
| `shared.ts` | Add `renderGraphFinding` | +50 |
| `overview.ts` | Extend per-tool stats | +50 |

Total ~500 LOC of new dashboard code in `contracts`, plus the fifth panel rendering live data.

---

## 10. Fitness integration (deferred)

A user running `fit` should be able to see graph signals alongside `no-console-log` findings. The architecture allows this without rework, but it's deferred to post-v0.1 of graph.

### 10.1 Three relationship modes

| Mode | What it means | When to ship |
|---|---|---|
| **A — sibling Tool** | `graph` runs separately from `fit`. Separate command, separate output. | v0.1 (current spec) |
| **B — graph-as-checks** | `fit` includes graph rules via a check pack. Graph signals appear in fit findings. | Post-v0.1 |
| **C — both** | Both A and B coexist. `graph` is the deep tool; `@opensip-tools/checks-graph` is the slim integration for `fit`. | End state |

### 10.2 Why C is the right end state

- `graph` stays the deep tool — full catalog, all five rules, dedicated subcommands, full output.
- A check pack `@opensip-tools/checks-graph` exposes the high-confidence error-severity rules (`orphan-subtree`, `always-throws-branch`) inside `fit`. The medium-confidence rules stay graph-only because they need the dedicated UI.
- A user running `fit` in CI gets the load-bearing graph regressions in their PR signal. A user running `graph` gets the full picture.
- The check pack is a **thin shim** — ~100 LOC.

### 10.3 Why we can defer without paying technical debt

The seam choices in the architecture already enable this:

- Graph **rules are pure functions** (`(catalog, config) => Signal[]`). They don't depend on the graph tool's CLI or any I/O. The check pack imports the rules and runs them, period.
- The **catalog cache** is shared. When fit runs the graph rules via the check pack, it reads `<project>/opensip-tools/.runtime/cache/graph/catalog.json`. If a `graph` run already populated the cache, fit reuses it. Otherwise the check pack runs the catalog builder. Either way, no double-work.
- The **check pack adapter** is one `defineCheck({ analyzeAll: ... })` call that delegates to the graph engine and converts its `Signal[]` output to fitness `CheckViolation[]`.

The follow-up work (when we decide to ship C):

1. Create `packages/fitness/checks-graph/` (Layer 4 check pack).
2. Add `dependencies: { '@opensip-tools/graph': 'workspace:*' }` (cross-Layer-3 peer dep, like the existing `lang-typescript → fitness` exception — needs a documented dep-cruiser carve-out).
3. Implement the adapter in ~100 LOC.
4. Add to the release workflow.

That's it. No rework of the graph engine, no rework of the rules, no breaking changes to either tool.

### 10.4 What the user experience looks like after C ships

```bash
# Fitness PR gate (graph integration enabled by default once shipped)
opensip-tools fit --gate-compare
# → fitness checks + graph:orphan-subtree + graph:always-throws-branch

# Deep graph analysis (same data, full output, dedicated subcommands)
opensip-tools graph
opensip-tools graph orphans
opensip-tools graph entry-points
```

Until C ships, users opt in by running `graph` explicitly in CI alongside `fit`.

---

## Appendix A — Conceptual design recap

The conceptual design that produced this spec, in compact form:

### The catalog schema (full type definitions go in `src/catalog/types.ts`)

```ts
interface FunctionNode {
  // Identity (hybrid id: contentHash + filePath + simpleName)
  readonly id: string;
  readonly qualifiedName: string;
  readonly simpleName: string;

  // Location
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;

  // Signature
  readonly kind: 'function' | 'method' | 'arrow' | 'constructor' | 'getter' | 'setter';
  readonly params: readonly { name: string; optional: boolean; rest: boolean }[];
  readonly returnType?: string;

  // Visibility
  readonly exportedFrom?: string;
  readonly visibility: 'exported' | 'module-local' | 'private';
  readonly enclosingClass?: string;
  readonly decorators: readonly string[];

  // Side effects (computed lazily; null until rule runs)
  readonly directSideEffects: readonly SideEffectKind[] | null;

  // Test-status
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;

  // Outgoing edges
  readonly calls: readonly CallSite[];
}

interface CallSite {
  readonly line: number;
  readonly column: number;
  readonly resolvedTo: readonly string[];   // FunctionNode.id values; multiple = polymorphic
  readonly resolution: 'static' | 'method-dispatch' | 'unknown' | 'dynamic-string';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly text: string;
}
```

### The id format

```
fn:${contentHash}@${filePath}#${simpleName}
```

`contentHash` is sha256 of the function body (between `{` and matching `}`, whitespace-collapsed, comments stripped). Same body in two files → same `contentHash` (catches DRY violations). Adding `filePath` and `simpleName` as tiebreakers makes the full id unique without losing the join key.

### The 8-kind side-effect taxonomy

`io.fs`, `io.network`, `io.process`, `database`, `logging`, `state.module`, `state.global`, `control.throw`.

Defaults map to `node:*` builtins; override via `graph.sideEffects.{moduleAliases, pureModules, pureFunctionPatterns, impureFunctionPatterns, disabled}` in `opensip-tools.config.yml`.

### The five rules

| ruleId | Severity | What fires |
|---|---|---|
| `graph:orphan-subtree` | error | Function with no caller (and no inferred entry-point ancestor); reports the subtree |
| `graph:test-only-reachable` | warning | Function reachable only from `*.test.ts` paths |
| `graph:no-side-effect-path` | warning | Function whose entire transitive callee tree has zero side effects |
| `graph:always-throws-branch` | error | A branch within a function where every reachable path throws |
| `graph:duplicated-function-body` | warning | Two or more functions with byte-identical bodies (content-hash collision) |

### Entry-point inference

For each zero-caller function, classify in order:
1. Inferred entry point (binary, route handler, name-heuristic match, `package.json#bin`/`exports`, has external callers across packages)
2. Test-only (defined in test file, all transitive ancestors in test files)
3. Plugin-discoverable (exported from a package whose `package.json` has `opensipTools.kind`)
4. Dynamic dispatch only (function name appears as a string literal passed to a known dispatcher)
5. Orphan (none of the above match)

The `externalCallers` pass — counting cross-crate imports of an exported function — is what distinguishes "exported and used" from "exported and unused." See [section 3.4 of fitness loop doc](../architecture/10-mental-model/01-fitness-loop.md) for pattern parallels.

---

## Status

Draft, ready for implementation. No code in `packages/graph/` yet. A coder agent picking this up should:

1. Create `packages/graph/engine/` with the package layout in §1.2.
2. Update `pnpm-workspace.yaml` to include `packages/graph/*`.
3. Update `.dependency-cruiser.cjs` with the two new rules (`graph-no-cli`, `graph-typescript-only-on-lang-typescript`).
4. Update `packages/core/src/lib/paths.ts` to extend `PathDomain` with `'graph'` and add the three new path fields (§8.2).
5. Update `packages/contracts/src/persistence/store.ts` to extend `StoredSession.tool` with `'graph'` (§8.4).
6. Update `packages/cli/src/index.ts` to import and register `graphTool`.
7. Update `packages/cli/package.json` to add `@opensip-tools/graph: workspace:*`.
8. Update the release workflow `.github/workflows/release.yml` to pack and publish the new package in dependency order (Layer 3, alongside fitness/simulation; before checks-*).
9. Build P0–P3 (skeleton through polymorphic resolver) as a single PR; P4–P7 as follow-ups.
10. Build dashboard integration (§9) as a separate PR, gated behind P3 completing.
11. Add a row in `docs/architecture/70-reference/01-package-catalog.md` and update the layer narrative in `docs/architecture/10-mental-model/03-modular-monolith.md`.

The scope for the first PR (P0–P3) is roughly: 1500–2500 LOC of TypeScript, 800–1200 LOC of tests, ~3 days of focused work for an experienced TS engineer.

The dashboard integration PR (§9) adds ~500 LOC to `@opensip-tools/contracts` and is largely independent of the graph engine — can run in parallel after P3 ships.

The fitness integration (§10 — `@opensip-tools/checks-graph`) is **explicitly post-v0.1** and ~100 LOC of follow-up work. Architecture supports it; do not pre-build.
