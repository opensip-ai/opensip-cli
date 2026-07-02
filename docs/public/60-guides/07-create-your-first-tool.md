---
status: current
last_verified: 2026-06-26
release: v0.2.1
title: "Create your first Tool"
audience: [plugin-authors, contributors]
purpose: "Task-led guide for creating a tracked project-local Tool plugin that adds a custom opensip-cli subcommand."
source-files:
  - packages/core/src/plugins/manifest-loader.ts
  - packages/core/src/tools/command-spec.ts
  - packages/core/src/tools/create-tool.ts
  - packages/cli/src/bootstrap/register-tools.ts
  - packages/cli/src/commands/tools/create.ts
  - packages/cli/src/__tests__/authored-tool-load.test.ts
related-docs:
  - ../50-extend/06-full-tool-plugins.md
  - ../50-extend/07-command-taxonomy.md
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
  - ../../decisions/ADR-0076-tool-authoring-template-and-helper-boundary.md
---
# Create your first Tool

A Tool plugin adds a whole subcommand to `opensip-cli`. Use this path when your work is not a fitness check, simulation scenario, or graph adapter.

This guide scaffolds a tracked project-local Tool under `opensip-cli/tools/` using
`opensip tools create`. It is the fastest way to understand the contract before you
package a Tool for npm.

Project-local tools are **executable code**, **deny-by-default**, and **not
sandboxed** after you trust them in project config. Do not use wildcard env
overrides unless you trust every project-local tool in the repo.

## 1. Scaffold the tool

### Minimal JS (default smoke path)

Zero npm dependencies — ideal for a quick trust/run check:

```bash
opensip tools create hello-tools
```

This writes `opensip-cli/tools/hello-tools/opensip-tool.manifest.json` and
`index.mjs`.

### Typed local package (`ts-local`)

For TypeScript authoring with `defineTool()` from `@opensip-cli/core`:

```bash
opensip tools create hello-tools --template ts-local
```

This adds `package.json`, `tsconfig.json`, `src/index.ts`, tests, and a README.
The sidecar points at `./dist/index.js`, so build before validate/run:

```bash
cd opensip-cli/tools/hello-tools
pnpm install
pnpm run build
pnpm test
```

## 2. Sidecar manifest shape

Generated manifests include `identity` and `stableId` (required by the real
sidecar validator):

```json
{
  "kind": "tool",
  "id": "hello-tools",
  "identity": { "name": "hello-tools" },
  "stableId": "8f1e2d3c-4b5a-6789-0abc-def123456789",
  "name": "hello-tools",
  "version": "0.1.0",
  "apiVersion": 1,
  "main": "./index.mjs",
  "commands": [
    { "name": "hello-tools", "description": "Run hello-tools" }
  ]
}
```

The manifest is read before the module is imported. Runtime `metadata.id` must
match `stableId`; `metadata.name` and command names must match the manifest.

## 3. Runtime entry

`minimal-js` emits a dependency-free plain object. `ts-local` emits:

```ts
import { definePrimaryCommand, defineTool } from '@opensip-cli/core';

const primaryCommand = definePrimaryCommand({
  description: 'Run hello-tools',
  commonFlags: ['json'],
  scope: 'none',
  output: 'command-result',
  handler: async () => ({
    type: 'text-lines',
    title: 'hello-tools',
    lines: ['Your project-local tool is ready.'],
  }),
});

export const tool = defineTool({
  identity: { name: 'hello-tools' },
  metadata: {
    id: '<stableId-from-manifest>',
    version: '0.1.0',
    description: 'Project-local typed tool',
  },
  commandSpecs: [primaryCommand],
});
```

`createTool()` remains as a compatibility wrapper over `defineTool()`, but new
templates teach the explicit command-spec path directly. Neither path adds
hidden lifecycle hooks.

## 4. Validate

```bash
# minimal-js
opensip tools validate opensip-cli/tools/hello-tools

# ts-local (after build + install deps in the tool dir)
opensip tools validate opensip-cli/tools/hello-tools --install-deps
```

Validation executes candidate code in a child process. It is a coherence check,
not a security sandbox.

## 5. Trust the project-local Tool

`opensip tools create` adds the new tool id to `tools.trusted` in
`opensip-cli.config.yml`:

```yaml
tools:
  trusted:
    - hello-tools
```

Commit that config entry with the tool so teammates and CI load the same
intentional project-local Tool. `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` remains
available as an override, but it is not the normal scaffold path.

## 6. Run it

```bash
opensip hello-tools
opensip hello-tools --json
```

### Logging and failures in your handler

Log run start with the scope-backed logger (writes to `.runtime/logs/` when configured):

```ts
cli.logger.info({ evt: 'hello-tools.run.start', module: 'hello-tools:cli' });
```

When the command cannot run (missing recipe, bad path), report a failure through the host:

```ts
await cli.reportFailure({
  message: 'Recipe not found: example',
  exitCode: 2,
  jsonRequested: opts.json === true,
});
```

Uncaught `ToolError` subclasses are also rendered by the host — prefer `reportFailure`
when you want a custom message or structured log event.

## 7. See it in the Tool inventory

```bash
opensip tools list --project
```

The row should show the `hello-tools` id, `project` source, and `hello-tools` command.

## 8. What changes for publishable Tools

The tracked sidecar layout is ideal while authoring inside one repo. To distribute a Tool:

1. Move the runtime into an npm package.
2. Put the manifest under `package.json#opensipTools` with `kind: "tool"`, `identity`, and `stableId`.
3. Export `tool` from the package main.
4. Run `opensip tools validate <spec>`.
5. Install with `opensip tools install <spec>`.

A publishable npm scaffold is deferred until consumption-side verification and
trust enforcement mature (see [ADR-0076](../../decisions/ADR-0076-tool-authoring-template-and-helper-boundary.md)).

`tools validate` and `tools install` execute the candidate package module as part of validation. Install scripts are blocked and runtime probing has a timeout, but this is still code execution with your user privileges.

## Where to go next

| You want to ... | Go to |
|---|---|
| Learn the full Tool contract | [Full Tool plugins](../50-extend/06-full-tool-plugins.md) |
| Read the command grammar | [Command surface taxonomy](../50-extend/07-command-taxonomy.md) |
| Manage installed Tools | [`tools` command](../70-reference/12-tools-command.md) |
| See trust override environment variables | [Environment variables](../70-reference/10-environment-variables.md) |
| Understand Tool architecture | [The tool-plugin model](../10-concepts/02-tool-plugin-model.md) |
