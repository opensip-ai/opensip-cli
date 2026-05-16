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
  - ../60-surfaces/01-cli-command-tree.md
---
# CLI dispatch

`packages/cli/src/index.ts` is the binary's entry point. It does the same eight things on every invocation and then hands argv to Commander. This doc walks those eight things.

> **What you'll understand after this:**
> - The exact startup sequence, in order.
> - Which commands are CLI-owned (`init`, `plugin`, `configure`, `uninstall`) vs. tool-owned (`fit`, `sim`, `dashboard`).
> - The global flag set vs. per-command flags.
> - How the CLI handles errors before, during, and after Tool execution.

---

## The startup sequence

```
1. Read argv, peek for --debug to set log level early.
2. Generate a runId. Initialize the logger and the run-scoped log file.
3. Configure persistence paths from cwd().
4. Register language adapters (synchronous module-load side effects).
5. Register first-party tools statically (fitnessTool, simulationTool).
6. Discover third-party Tool packages from node_modules. Register each.
7. Build the Commander program. Mount CLI-owned commands. Call register()
   on every Tool to mount their commands.
8. await program.parseAsync(argv).
```

The whole thing fits in [`packages/cli/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/cli/src/index.ts) at ~250 lines. Every step is direct — no plugin lifecycle hooks, no startup phases, no DI container. Just static imports and explicit registration calls.

### Why this order

A few of the constraints that pinned the order:

- **Language adapters before tool registration.** The fitness tool's content filter dispatches per-file based on the language registry. A check that runs before any adapter is registered would treat every file as raw text and silently miss violations. Step 4 happens at module-load time so it can't be ordered after Step 5.
- **First-party tools before discovery.** `defaultToolRegistry.register()` is last-writer-wins. Registering the bundled tools first lets a third-party tool with the same id (e.g. a custom `fitness` replacement) override them — same as how a third-party check pack can override a first-party display entry.
- **Tool registration before `register()`.** Two passes: register the Tools (to populate the registry, used for `--help` listings even when no command is invoked), then call `register(cli)` on each Tool to mount Commander commands. Splitting the passes lets `--help` enumerate available commands without invoking each Tool's mount logic.
- **`parseAsync` last.** Commander parses argv synchronously but action handlers are async. `parseAsync` returns when the action handler resolves, which is what blocks Node's event loop until the run completes.

---

## CLI-owned commands

Some commands belong to the CLI itself, not to any Tool. They live under [`packages/cli/src/commands/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/cli/src/commands/) and are mounted directly in `index.ts` (not via the Tool contract):

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

When the binary is invoked without arguments (or with bare `--help`), the CLI prints a welcome banner: the version, a short description of what `opensip-tools` does, and a numbered list of common next-step commands. Source: [`packages/cli/src/welcome.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/cli/src/welcome.ts).

The welcome screen is also where the update-notifier hook runs. If a newer version of `@opensip-tools/cli` is published, a small "update available" line is printed below the banner. The check is rate-limited (one per 24 hours, cached in `~/.opensip-tools/.update-cache`) and is skipped under CI environment detection. See [`packages/cli/src/update-notifier.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/cli/src/update-notifier.ts).

The banner does not appear when a command is invoked. It's strictly a no-argv affordance — running `opensip-tools fit` skips the welcome and goes straight to the run.

---

## The error-suggestion mapping

Some errors produced inside a Tool carry a `code` (e.g. `'CONFIG.MISSING'`). The CLI maps these codes to human-readable suggestions before rendering the error result:

```ts
import { getErrorSuggestion } from '@opensip-tools/contracts';

// inside the action handler:
catch (error) {
  const code = (error as ToolError)?.code;
  const suggestion = getErrorSuggestion(code);
  return { type: 'error', message: error.message, suggestion, exitCode: 2 };
}
```

The suggestion is a one-line hint — "Run `opensip-tools init` first" or "Check that `opensip-tools.config.yml` is valid YAML." The Tool author throws an error with a code; the CLI handles the rendering. The mapping is centralized in [`packages/contracts/src/exit-codes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.4/packages/contracts/src/exit-codes.ts) so the same code surfaces the same suggestion regardless of which Tool threw it.

This is the polite way the CLI extends Tool errors. The Tool doesn't have to know about the suggestion; it just throws with a code. The CLI doesn't have to know about the Tool; it just looks up the code.

---

## Failure paths

Things that can go wrong, and what the CLI does:

| Failure | When | What the CLI does |
|---|---|---|
| Invalid argv | Commander parse | Commander prints help; exit 1. |
| Tool registration throws | Step 5 or 7 | Logged at error level; the failing tool is skipped; CLI continues with remaining tools. |
| Action handler throws | Inside Tool execution | Caught at the program level; rendered as `ErrorResult`; exit code from `error.exitCode` or 2. |
| Missing config | Tool action calls `loadProjectConfig()` | Tool throws `ConfigurationError`; CLI surfaces the error and the suggestion. Exit 2. |
| Plugin failed to load | Step 7 (Tool's `register()` calls into the loader) | Logged; the failing plugin is skipped; CLI continues. |
| Missing baseline (gate) | `fit --gate-compare` with no baseline | Tool throws `GateBaselineMissingError`; CLI surfaces a hint to run `--gate-save`. Exit 2. |

The principle is "log, fall back, keep moving" for non-fatal failures (a plugin couldn't load, a Tool couldn't register) and "surface and exit" for fatal ones (no config, broken baseline, action handler crash). The CLI never silently swallows an error — every failure produces either a log line or a rendered error.

---

## Where the example lands

For `acme-api` running `opensip-tools fit --gate-compare` from CI:

1. Step 1: argv is `['node', 'opensip-tools', 'fit', '--gate-compare']`. `--debug` is not set, so log level is the default `info`.
2. Step 2: runId `run_4kqj2x9p1f` is generated. Log file at `<project>/opensip-tools/.runtime/logs/run_4kqj2x9p1f.jsonl` is opened.
3. Step 3: persistence paths configured for `cwd = /workspace/acme-api`.
4. Step 4: six language adapters registered (`typescript`, `rust`, `python`, `java`, `go`, `cpp`).
5. Step 5: `fitnessTool`, `simulationTool` registered.
6. Step 6: `discoverToolPackages` walks `node_modules`. No third-party Tools installed. Returns empty.
7. Step 7: `init`, `configure`, `uninstall`, `plugin`, `completion`, `sessions` mounted. `fitnessTool.register(cli)` mounts `fit`, `dashboard`, `fit-list`, `fit-recipes`. `simulationTool.register(cli)` mounts `sim`.
8. Step 8: Commander dispatches to `fitnessTool`'s `fit` action handler with `--gate-compare = true`. The Tool runs `executeFit` and the gate diff. Exit code 1 (regression detected).

The whole bootstrap is ~30ms on a developer laptop; the run itself is the bulk of the wall-clock time.

---

## What's next

- **[`02-plugin-loader.md`](/docs/opensip-tools/40-runtime/02-plugin-loader/)** — what happens inside Step 6 and inside the Tool's lazy plugin loading.
- **[`03-session-and-persistence.md`](/docs/opensip-tools/40-runtime/03-session-and-persistence/)** — what gets written to disk during and after a run.
- **[`../60-surfaces/01-cli-command-tree.md`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/)** — the lookup-shaped reference for every command and flag.
