---
status: current
last_verified: 2026-06-12
release: v0.1.2
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
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
---
# Create your first Tool

A Tool plugin adds a whole subcommand to `opensip-cli`. Use this path when your work is not a fitness check, simulation scenario, or graph adapter.

This guide creates a tracked project-local Tool under `opensip-cli/tools/`. It is the fastest way to understand the contract before you package a Tool for npm.

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
    { "name": "hello-tools", "description": "Print a Tool plugin hello" }
  ]
}
```

The manifest is read before the module is imported. Its `id` must match the runtime Tool's `metadata.id`, and its command names must match the runtime `commands` and `commandSpecs`.

## 3. Add the runtime

Create `opensip-cli/tools/hello-tools/index.mjs`:

```js
export const tool = {
  metadata: {
    id: 'hello-tools',
    version: '1.0.0',
    description: 'Small project-local Tool example',
  },
  commands: [
    { name: 'hello-tools', description: 'Print a Tool plugin hello' },
  ],
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
  ],
};
```

This example uses a plain object so it has no package dependencies. A publishable Tool package can use `defineCommand` and TypeScript types from `@opensip-cli/core`.

## 4. Allowlist the project-local Tool

Tracked project-local Tools are executable code, so they are deny-by-default. Admit this Tool for the current shell:

```bash
export OPENSIP_CLI_ALLOW_PROJECT_TOOLS=hello-tools
```

Use a comma-separated list for more than one Tool, or `*` only when you trust every project-local Tool in the repo.

## 5. Run it

```bash
opensip hello-tools
```

You can also ask for JSON because the command declared the shared `json` flag:

```bash
opensip hello-tools --json
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
| Learn the full Tool contract | [Full Tool plugins](/docs/opensip-cli/50-extend/06-full-tool-plugins/) |
| Manage installed Tools | [`tools` command](/docs/opensip-cli/70-reference/12-tools-command/) |
| See the allowlist environment variable | [Environment variables](/docs/opensip-cli/70-reference/10-environment-variables/) |
| Understand Tool architecture | [The tool-plugin model](/docs/opensip-cli/10-concepts/02-tool-plugin-model/) |
