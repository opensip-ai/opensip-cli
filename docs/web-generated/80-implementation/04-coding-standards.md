---
status: current
last_verified: 2026-06-07
release: v2.8.0
title: "Coding standards"
audience: [contributors]
purpose: "How code in this workspace is written. ESLint posture, error handling, exit codes, log style."
source-files:
  - .config/eslint.config.mjs
  - tsconfig.json
  - packages/core/src/lib/errors.ts
  - packages/core/src/lib/logger.ts
  - packages/contracts/src/exit-codes.ts
  - knip.json
related-docs:
  - ./05-layer-policy.md
  - ./06-doc-conventions.md
  - ../70-reference/02-package-catalog.md
---
# Coding standards

The workspace's quality gates are: TypeScript strict mode, ESLint with type-aware rules, dependency-cruiser for layer enforcement, knip for unused exports. The build fails on any of those. This doc describes the conventions those gates enforce.

> **What you'll understand after this:**
> - The ESLint rule set and the few documented exceptions.
> - How errors are constructed and propagated.
> - The exit-code convention.
> - Logger event naming.
> - Comment policy: when to write one, when not to.

---

## TypeScript

The workspace root [`tsconfig.json`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/tsconfig.json) sets `target: ES2022`, `module: Node16`, `moduleResolution: Node16`, and `strict: true`. Each package has its own `tsconfig.json` that extends those settings.

Notable settings:

- `strict: true` — all strict-mode flags on (`strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, etc.).
- `module: Node16` / `moduleResolution: Node16` — relative imports must carry the `.js` extension; this is what ESM Node16 module resolution requires.
- `declaration: true`, `declarationMap: true`, `sourceMap: true` — packages publish `.d.ts` and source maps.
- `target: ES2022` — modern JS output; no transpilation tax for `await`/`?.`/etc.

`exactOptionalPropertyTypes` is **not** enabled. Optional fields can be `undefined` without `| undefined` in the type — the codebase treats `field?: T` as `field?: T | undefined`.

---

## ESLint

Flat config at [`.config/eslint.config.mjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/.config/eslint.config.mjs). The base layers:

- `@eslint/js` recommended.
- `typescript-eslint` `recommendedTypeChecked` + `stylisticTypeChecked`.
- `eslint-plugin-sonarjs` recommended.
- `eslint-plugin-unicorn` recommended (selectively).
- `eslint-plugin-import` for import-order and circular-dep detection.

### Tunings

- **`sonarjs/cognitive-complexity`** — default 15. The CLI's fit-command dispatcher and a few SARIF-related modules exceed it; we add per-file disables (with justification) rather than weaken the workspace setting.
- **`unicorn/prevent-abbreviations`** — OFF. Domain abbreviations (`cwd`, `ctx`, `opts`, `cli`, `bin`) are vocabulary; expanding them is noise.
- **`unicorn/no-null`** — OFF. The codebase uses `null` deliberately for JSON-serialized boundaries (an absent value in JSON is `null`, not `undefined`).
- **`import/no-unresolved`** — uses TypeScript resolver via the `.ts` extension list; node_modules are resolved by tsconfig moduleResolution.

### Per-file exceptions

A file can opt out of a specific rule by writing a directive comment at the top:

```ts
// @fitness-ignore-file module-coupling-metrics -- central orchestration; coupling is necessary
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-section diff renderer reads better inline
```

The convention is: **always include a justification after `--`**. A bare `eslint-disable-next-line` without a reason is a smell — future contributors won't know whether the suppression is still needed.

The `@fitness-ignore-file` directives are opensip-tools' own (eaten by the fitness check framework, not ESLint). They're used to suppress fitness-check violations on the workspace's own source — yes, opensip-tools dogfoods itself.

---

## Errors

[`packages/core/src/lib/errors.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/packages/core/src/lib/errors.ts) defines the workspace's error hierarchy:

```ts
interface ToolErrorOptions extends ErrorOptions { code?: string; [key: string]: unknown }

class ToolError extends Error {
  readonly code: string;
  // `cause` is inherited from base `Error` via the options bag (ES2022).
  constructor(message: string, code: string, options?: ToolErrorOptions);
}

class ValidationError    extends ToolError { /* default code: 'VALIDATION_ERROR' */ }
class NotFoundError      extends ToolError { /* default code: 'NOT_FOUND' */ }
class SystemError        extends ToolError { /* default code: 'SYSTEM_ERROR' */ }
class TimeoutError       extends ToolError { /* default code: 'TIMEOUT'; second arg is `number | ToolErrorOptions` */ }
class NetworkError       extends ToolError { /* default code: 'NETWORK_ERROR'; supports { statusCode } */ }
class ConfigurationError extends ToolError { /* default code: 'CONFIGURATION_ERROR' */ }
```

Plus the `Result<T, E>` pattern with `ok(value)` / `err(error)` / `tryCatch(fn)` / `tryCatchAsync(fn)` exported from the same module.

### When to throw vs. return Result

- **Throw `ToolError` subclasses** at boundaries where the caller is the framework or the CLI. The action handler wraps the throw, maps the code to a suggestion, and renders an error result.
- **Return `Result<T, E>`** in tight loops where allocating exception objects is hot, or where multiple error kinds are equally first-class.
- **Throw plain `Error`** *never*. Always one of the typed subclasses, with a `code`.

### Error codes

Each error subclass ships with a sensible default: `VALIDATION_ERROR`, `NOT_FOUND`, `SYSTEM_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `CONFIGURATION_ERROR`. Call sites that want a more specific code pass `{ code: '...' }` as the second argument, e.g. `new ValidationError('bad', { code: 'SCHEMA_FAIL' })`. Most production throws today use the defaults; the shape is in place for future scoped codes.

Errors are mapped to user-facing suggestions by [`getErrorSuggestion`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/packages/contracts/src/exit-codes.ts):

```ts
export interface ErrorSuggestion {
  message: string;
  action?: string;
  exitCode: number;
}

export function getErrorSuggestion(err: unknown): ErrorSuggestion | null {
  // pattern-matches on the error message and returns a structured suggestion,
  // or null if no rule matched.
}
```

The CLI calls `getErrorSuggestion(error)` and threads the returned `{ message, action, exitCode }` into the `ErrorResult` the renderer shows. Tools throw a typed error; the CLI does the message-matching and renders.

---

## Exit codes

Defined exactly once in [`packages/contracts/src/exit-codes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/packages/contracts/src/exit-codes.ts):

```ts
export const EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,           // checks/scenarios failed, or unhandled runtime error
  CONFIGURATION_ERROR: 2,     // run could not start (config invalid, recipe unknown, plugin failed)
  CHECK_NOT_FOUND: 3,         // --check slug doesn't match any registered check
  REPORT_FAILED: 4,           // --report-to delivery failure
} as const;
```

Tools call `cli.setExitCode(code)` instead of mutating `process.exitCode` directly. The CLI mediates the final exit so it can run dashboard launching / cleanup after the Tool is done.

Adding a new exit code is a major-version change — see [`10-concepts/04-contract-surfaces.md`](/docs/opensip-tools/10-concepts/04-contract-surfaces/).

---

## Logging

The structured logger is in [`packages/core/src/lib/logger.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.10.0/packages/core/src/lib/logger.ts). Every log entry carries:

- `evt` — dot-separated event name (`cli.fit.run.start`, `plugin.loader.discover`, `gate.compare.complete`).
- `module` — the module that emitted it (`cli:fit`, `core:plugins`, `cli:gate`).
- `runId` — per-run correlation, set at startup.
- Additional event-specific fields.

Levels: `error`, `warn`, `info`, `debug`. Default `info`. `--debug` raises to `debug`. `--quiet` does *not* affect the log level.

### Event naming

Event names are stable identifiers. They appear in CI logs, in the dashboard, and in any external log aggregator. Renaming an event is a breaking change for anyone grepping for it.

The convention:

```
<surface>.<action>[.<phase>]
```

Examples:

- `cli.fit.run.start` — the fit run is starting.
- `cli.fit.run.complete` — the fit run finished.
- `plugin.loader.discover` — discovery completed.
- `gate.compare.complete` — gate finished comparing.
- `cli.report.chunk.start` / `cli.report.chunk.done` — cloud report chunk lifecycle.

The phase is optional. A simple event like `cli.gate.config_error` doesn't need one.

### What to include

A log entry should answer "what happened, in what context, with what outcome." Things to include:

- The numeric counts (how many checks, findings, plugins, etc.).
- The relevant identifiers (slug, recipeName, baselinePath).
- The duration when it's interesting.

Things to leave out:

- Verbatim user content (file content, secrets).
- Full file paths if a relative path suffices.
- Stack traces by default — they're attached to logger.error() entries automatically.

---

## Imports

The import ordering is enforced by `eslint-plugin-import`:

```ts
// 1. Node built-ins
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 2. Third-party
import { z } from 'zod';

// 3. Internal workspace deps (alphabetical by package)
import { logger, ToolError } from '@opensip-tools/core';
import { EXIT_CODES } from '@opensip-tools/contracts';

// 4. Local relative imports
import { sarifBuilder } from './sarif.js';
import type { Check } from './types.js';
```

Type-only imports use `import type` so they're erased at compile time. The main dep-cruiser pass ignores type-only imports (`tsPreCompilationDeps: false`) because they carry no runtime edge — but this does **not** mean you may `import type` from a higher layer. A second, type-aware pass (`.config/dependency-cruiser.types.cjs`, `tsPreCompilationDeps: true`) re-runs the full layer ruleset over the type-inclusive graph, so a type-only layer inversion or cycle is still rejected. Both passes run under `pnpm lint`. See [`05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/#how-to-add-a-new-exception) and [`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/#type-only-edges-are-caught-by-the-type-aware-pass).

---

## Comments

Default to writing no comments. Only add one when:

- The **why** is non-obvious — a hidden constraint, a workaround for a specific bug, behavior that would surprise a reader.
- The **invariant** isn't visible in the code — "this map is keyed by hash and order doesn't matter" or "this function must run before X is registered."
- A **per-file fitness directive** suppresses a check with a justification.

Don't write comments that:

- Explain what well-named code already says.
- Reference current tasks, fixes, or callers ("used by X", "added for Y", "handles issue #123") — those belong in PR descriptions.
- Restate the function signature.

`@fileoverview` JSDoc is acceptable on the entry file of a module that has multiple consumers — it's the first thing a reader sees, and a one-paragraph summary saves them the work of inferring the module's role from the export list.

---

## Test layout

Tests live alongside source under `__tests__/` directories:

```
packages/fitness/engine/src/
├── gate.ts
└── __tests__/
    └── gate.test.ts
```

Vitest is the runner. Tests are compiled and type-checked with the same TS config as source. The dep-cruiser config excludes `__tests__/` and `*.test.ts` files from the layer rules — tests can import anything.

Naming: `*.test.ts` for unit tests, `*.integration.test.ts` for cross-package integration tests. Snapshot files go in `__snapshots__/`.

---

## What's next

- **[`05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/)** — the dep-cruiser config, rule by rule, with rationale.
- **[`06-doc-conventions.md`](/docs/opensip-tools/80-implementation/06-doc-conventions/)** — voice, frontmatter, and verification trails for documentation.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)** — the workspace package list these standards apply to.
