---
status: current
last_verified: 2026-06-21
release: v0.1.9
title: "Create your first Tool"
audience: [plugin-authors, contributors]
purpose: "Task-led guide for creating a tracked project-local Tool plugin that adds a custom opensip-cli subcommand."
source-files:
  - packages/core/src/plugins/manifest-loader.ts
  - packages/core/src/tools/command-spec.ts
  - packages/cli/src/bootstrap/register-tools.ts
  - packages/cli/src/commands/tools/index.ts
  - packages/cli/src/__tests__/authored-tool-load.test.ts
related-docs:
  - ../50-extend/06-full-tool-plugins.md
  - ../50-extend/07-command-taxonomy.md
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
---
# Create your first Tool

A Tool plugin adds a whole subcommand to `opensip-cli`. Use this path when your work is not a fitness check, simulation scenario, or graph adapter.

This guide creates a tracked project-local Tool under `opensip-cli/tools/`. It is the fastest way to understand the contract before you package a Tool for npm.

The example uses the canonical nested grammar: a `hello-tools` primary plus a
`hello-tools list` discoverability child (`parent: 'hello-tools'`). See
[Command surface taxonomy](../50-extend/07-command-taxonomy.md) for the full
Tier-1/2/3 rules.

## 1. Create the directory

```bash
mkdir -p opensip-cli/tools/hello-tools
```

## 2. Add the sidecar manifest

Create `opensip-cli/tools/hello-tools/opensip-tool.manifest.json`:

```json
{
  "kind": "tool",
  "id": "hello-tools",
  "name": "Hello Tools",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "./index.mjs",
  "commands": [
    { "name": "hello-tools", "description": "Print a Tool plugin hello" },
    { "name": "list", "description": "List hello variants" }
  ]
}
```

The manifest is read before the module is imported. Its `id` must match the runtime Tool's `metadata.id`, and its command names must match the runtime descriptors derived from `commandSpecs`.

## 3. Add the runtime

Create `opensip-cli/tools/hello-tools/index.mjs`:

```js
const HELLO_VARIANTS = ['formal', 'casual', 'pirate'];

export const tool = {
  metadata: {
    id: 'hello-tools',
    name: 'hello-tools',
    version: '1.0.0',
    description: 'Small project-local Tool example',
  },
  commandSpecs: [
    {
      name: 'hello-tools',
      description: 'Print a Tool plugin hello',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => ({
        type: 'text-lines',
        title: 'Hello Tools',
        lines: ['Your project-local Tool is loaded.'],
      }),
    },
    {
      name: 'list',
      parent: 'hello-tools',
      description: 'List hello variants',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => ({
        type: 'text-lines',
        title: 'Hello variants',
        lines: HELLO_VARIANTS,
      }),
    },
  ],
};
```

This example uses plain objects so it has no package dependencies. A publishable
Tool package can use `defineCommand`, `defineTool`, and TypeScript types from
`@opensip-cli/core` — `defineTool` derives `commands[]` from `commandSpecs`, so
you do not hand-maintain a parallel `commands` array.

If your TypeScript Tool contributes a typed per-run subscope, add a
`scope-augmentation.ts` file and import it from the Tool entry for side effects:

```ts
// scope-augmentation.ts
export interface HelloScope {
  readonly greetings: string[];
}

declare module '@opensip-cli/core' {
  interface ScopeContribution {
    helloTools?: HelloScope;
  }
}
```

```ts
// index.ts
import './scope-augmentation.js';

export const tool = {
  // ...
  contributeScope: () => ({ helloTools: { greetings: [] } }),
};
```

The import is required even though it has no bindings; it loads the module
augmentation so `cli.scope.helloTools` is typed when the package is compiled.

## 4. Allowlist the project-local Tool

Tracked project-local Tools are executable code, so they are deny-by-default. Admit this Tool for the current shell:

```bash
export OPENSIP_CLI_ALLOW_PROJECT_TOOLS=hello-tools
```

Use a comma-separated list for more than one Tool, or `*` only when you trust every project-local Tool in the repo.

## 5. Run it

```bash
opensip hello-tools
opensip hello-tools list
```

You can also ask for JSON because both commands declared the shared `json` flag:

```bash
opensip hello-tools --json
opensip hello-tools list --json
```

## 6. See it in the Tool inventory

```bash
opensip tools list --project
```

The row should show the `hello-tools` id, `project` source, and `hello-tools` command.

## 7. What changes for publishable Tools

The tracked sidecar layout is ideal while authoring inside one repo. To distribute a Tool:

1. Move the runtime into an npm package.
2. Put the manifest under `package.json#opensipTools` with `kind: "tool"`.
3. Export `tool` from the package main.
4. Run `opensip tools validate <spec>`.
5. Install with `opensip tools install <spec>`.

`tools validate` and `tools install` execute the candidate package module as part of validation. Install scripts are blocked and runtime probing has a timeout, but this is still code execution with your user privileges.

## Where to go next

| You want to ... | Go to |
|---|---|
| Learn the full Tool contract | [Full Tool plugins](../50-extend/06-full-tool-plugins.md) |
| Read the command grammar | [Command surface taxonomy](../50-extend/07-command-taxonomy.md) |
| Manage installed Tools | [`tools` command](../70-reference/12-tools-command.md) |
| See the allowlist environment variable | [Environment variables](../70-reference/10-environment-variables.md) |
| Understand Tool architecture | [The tool-plugin model](../10-concepts/02-tool-plugin-model.md) |