---
status: current
last_verified: 2026-05-15
title: "CLI dispatch"
audience: [contributors]
purpose: "How argv becomes a Tool action handler. The CLI bootstrap, registration order, the global flag set, error suggestions."
source-files:
  - packages/cli/src/index.ts
  - packages/cli/src/commands/init.ts
  - packages/cli/src/commands/configure.ts
  - packages/cli/src/commands/plugin.ts
  - packages/cli/src/commands/uninstall.ts
  - packages/cli/src/welcome.ts
  - packages/contracts/src/exit-codes.ts
related-docs:
  - ../10-mental-model/02-tool-plugin-model.md
  - ./02-plugin-loader.md
  - ./03-session-and-persistence.md
  - ../70-surfaces/01-cli-command-tree.md
---
# CLI dispatch

`packages/cli/src/index.ts` is the binary's entry point. It does the same five things on every invocation and then hands argv to Commander. This doc walks those five things.

> **What you'll understand after this:**
> - The exact startup sequence, in order.
> - Which commands are CLI-owned (`init`, `plugin`, `configure`, `uninstall`) vs. tool-owned (`fit`, `sim`, `dashboard`).
> - The global flag set vs. per-command flags.
> - How the CLI handles errors before, during, and after Tool execution.

---

## The startup sequence

```
1. Module-load side effects: register language adapters into
   defaultLanguageRegistry; register first-party tools (fitnessTool,
   simulationTool, graphTool) into defaultToolRegistry.
2. main():
     a. await loadDiscoveredTools()        ← walk node_modules for
                                             package.json declarations
                                             of opensipTools.kind === 'tool'
     b. registerAllTools()                 ← iterate the tool registry,
                                             call tool.register(cli) on
                                             each (mounts Commander
                                             subcommands)
     c. registerCliCommands()              ← mount CLI-owned commands
                                             (init, configure, sessions,
                                             plugin, completion, uninstall)
3. If argv has no subcommand, print the welcome banner and exit 0.
4. Fire the once-per-day update notifier (TTY-gated, non-blocking).
5. await program.parseAsync()
     The preAction hook reads --debug from each command's options and
     raises the log level for that run. A runId is generated and the
     day-level log file (logs/<YYYY-MM-DD>.jsonl) is opened lazily on
     first write.
```

The whole thing fits in [`packages/cli/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.0/packages/cli/src/index.ts) at ~530 lines. Every step is direct — no plugin lifecycle hooks, no startup phases, no DI container. Just static imports and explicit registration calls.

### Why this order

A few of the constraints that pinned the order:

- **Language adapters before any check ever runs.** The fitness tool's content filter dispatches per-file based on the language registry. A check that runs before any adapter is registered would treat every file as raw text and silently miss violations. The adapters are registered as a module-load side effect of importing `packages/cli/src/index.ts`, so they're in place before `main()` executes.
- **First-party tools before discovery.** `defaultToolRegistry.register()` is last-writer-wins. Registering the bundled tools at module-load time first lets a discovered third-party tool with the same id (e.g. a custom `fitness` replacement) override them. The discovery loop in `loadDiscoveredTools()` explicitly skips packages whose `metadata.id` matches one of the bundled tools so a non-customized third-party install can't accidentally clobber the built-ins.
- **Tools mount before CLI-owned commands.** Tool subcommands (`fit`, `sim`, `graph`, `dashboard`, …) get mounted in `registerAllTools()` first. CLI-owned commands (`init`, `sessions`, `plugin`, `configure`, `completion`, `uninstall`) are mounted afterwards in `registerCliCommands()`. The order avoids duplicate-name collisions (a tool can't squat a CLI-owned name) and keeps tool subcommands at the top of `--help`.
- **`parseAsync` last.** Commander parses argv synchronously but action handlers are async. `parseAsync` returns when the action handler resolves, which is what blocks Node's event loop until the run completes.

---

## CLI-owned commands

Some commands belong to the CLI itself, not to any Tool. They live under [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.0/packages/cli/src/commands/) and are mounted directly in `index.ts` (not via the Tool contract):

| Command | Owner | Why CLI-owned |
|---|---|---|
| `init` | CLI | Scaffolds the project layout. No Tool exists yet to own it. |
| `configure` | CLI | Manages user-level (`~/.opensip-tools/config.yml`) state. Cross-tool. |
| `uninstall` | CLI | Removes the user-level dotdir. Cross-tool. |
| `plugin add/remove/list/sync` | CLI | Manages project-pinned plugins. Cross-tool. |
| `completion` | CLI | Prints shell completion. Sources its catalog from `defaultToolRegistry`. |
| `sessions list/purge` | CLI | Reads the runtime session store. Cross-tool. |

Tool-owned commands (`fit`, `dashboard`, `fit-list`, `fit-recipes`, `sim`) are mounted by their Tool's `register()` call. The CLI's job is to provide the program; the Tool decides what handlers it gets.

The split is functional, not arbitrary. CLI-owned commands deal with concerns that span every Tool — initialization, plugins, sessions, user config. Tool-owned commands deal with concerns specific to that Tool's domain. A new Tool doesn't need to provide its own `init`; it inherits the CLI's.

---

## Global flags

Two flags apply to every command, mounted on the program itself rather than per-command:

- **`--debug`** — set the logger to debug level. Read in step 1 (before logger init) so debug logs are captured from the very first event.
- **`--quiet`** — suppress banner and box rendering. Tool action handlers honor this when mounting Ink views.

Per-command flags (`--recipe`, `--check`, `--gate-save`, `--cwd`, etc.) live on each command's Commander definition. Flags are not inherited from program to subcommand — Commander requires them to be explicitly mounted at the level the user invokes them.

The `--help` text for the program lists every registered Tool's `commands[]`. The `--help` text for a specific command shows the per-command flags. Both are auto-generated by Commander from the metadata.

---

## The welcome screen

When the binary is invoked without arguments (or with bare `--help`), the CLI prints a welcome banner: the version, a short description of what `opensip-tools` does, and a numbered list of common next-step commands. Source: [`packages/cli/src/welcome.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.0/packages/cli/src/welcome.ts).

The welcome screen is also where the update-notifier hook runs. If a newer version of `@opensip-tools/cli` is published, a small "update available" line is printed below the banner. The check is rate-limited (one per 24 hours, cached in `~/.opensip-tools/.update-cache`) and is skipped under CI environment detection. See [`packages/cli/src/update-notifier.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.0/packages/cli/src/update-notifier.ts).

The banner does not appear when a command is invoked. It's strictly a no-argv affordance — running `opensip-tools fit` skips the welcome and goes straight to the run.

---

## The error-suggestion mapping

When a Tool throws, the CLI passes the error to `getErrorSuggestion`, which pattern-matches the error message and returns a structured `{ message, action, exitCode }` suggestion (or `null` if no rule matched):

```ts
import { getErrorSuggestion } from '@opensip-tools/contracts';

// inside the action handler:
catch (error) {
  const suggestion = getErrorSuggestion(error);
  return suggestion
    ? { type: 'error', message: suggestion.message, suggestion: suggestion.action, exitCode: suggestion.exitCode }
    : { type: 'error', message: (error as Error).message, exitCode: 1 };
}
```

The suggestion is a one-line hint — "Run `opensip-tools init` to create one." or "Check `opensip-tools.config.yml` for syntax errors." The mapping is centralized in [`packages/contracts/src/exit-codes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.0/packages/contracts/src/exit-codes.ts) so the same error message surfaces the same suggestion regardless of which Tool threw it.

This is the polite way the CLI extends Tool errors. The Tool just throws; the CLI does the message-matching and rendering.

---

## Failure paths

Things that can go wrong, and what the CLI does:

| Failure | When | What the CLI does |
|---|---|---|
| Invalid argv | Commander parse | Commander prints help; exit 1. |
| Tool registration throws | Step 2.b — `registerAllTools()` | Logged at error level; the failing tool is skipped; CLI continues with remaining tools. |
| Action handler throws | Inside Tool execution | Caught at the program level; rendered as `ErrorResult`; exit code from `error.exitCode` or 2. |
| Missing config | Tool action calls `loadProjectConfig()` | Tool throws `ConfigurationError`; CLI surfaces the error and the suggestion. Exit 2. |
| Plugin failed to load | Inside the Tool's lazy plugin loader (e.g. `ensureChecksLoaded` in fitness) | Logged; the failing plugin is skipped; CLI continues. |
| Missing baseline (gate) | `fit --gate-compare` with no baseline | Tool throws `GateBaselineMissingError`; CLI surfaces a hint to run `--gate-save`. Exit 2. |

The principle is "log, fall back, keep moving" for non-fatal failures (a plugin couldn't load, a Tool couldn't register) and "surface and exit" for fatal ones (no config, broken baseline, action handler crash). The CLI never silently swallows an error — every failure produces either a log line or a rendered error.

---

## Where the example lands

For `acme-api` running `opensip-tools fit --gate-compare` from CI on 2026-05-17:

1. Module-load side effects: six language adapters (`typescript`, `rust`, `python`, `java`, `go`, `cpp`) registered into `defaultLanguageRegistry`. `fitnessTool`, `simulationTool`, `graphTool` registered into `defaultToolRegistry`.
2. `main()` runs:
   - `loadDiscoveredTools()` walks `node_modules`. No third-party Tools installed. Returns empty.
   - `registerAllTools()`: `fitnessTool.register(cli)` mounts `fit`, `dashboard`, `fit-list`, `fit-recipes`; `simulationTool.register(cli)` mounts `sim`; `graphTool.register(cli)` mounts `graph`.
   - `registerCliCommands()`: `init`, `configure`, `uninstall`, `plugin`, `completion`, `sessions` mounted.
3. `argv = ['node', 'opensip-tools', 'fit', '--gate-compare']` — there's a subcommand, so the welcome banner is skipped.
4. Update notifier fires (no-op — runs in background, won't block).
5. `parseAsync()` runs. The `preAction` hook reads the `fit` command's `opts.debug` (false) and leaves the log level at `info`. A runId like `run_4kqj2x9p1f` is generated; the day-level log file `<project>/opensip-tools/.runtime/logs/2026-05-17.jsonl` is opened on first write. Commander dispatches to `fitnessTool`'s `fit` action handler with `--gate-compare = true`. The Tool runs `executeFit` and the gate diff. Exit code 1 (regression detected).

The whole bootstrap is ~30ms on a developer laptop; the run itself is the bulk of the wall-clock time.

---

## What's next

- **[`02-plugin-loader.md`](/docs/opensip-tools/50-runtime/02-plugin-loader/)** — what happens inside `loadDiscoveredTools()` and inside the Tool's lazy plugin loading.
- **[`03-session-and-persistence.md`](/docs/opensip-tools/50-runtime/03-session-and-persistence/)** — what gets written to disk during and after a run.
- **[`../70-surfaces/01-cli-command-tree.md`](/docs/opensip-tools/70-surfaces/01-cli-command-tree/)** — the lookup-shaped reference for every command and flag.
