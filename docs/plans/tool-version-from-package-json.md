---
status: implemented
title: "Tools — read metadata.version from package.json"
audience: [contributors]
---

# Tools — read `metadata.version` from package.json

A small consistency improvement to the Tool plugin contract: stop hardcoding the version string in source code, read it from `package.json` at tool construction time. Eliminates a quiet failure mode that today only one of three first-party tools (`graph`) catches with a test.

---

## 1. The problem

Every first-party Tool declares its version twice — once in `package.json` and once as a literal string in its `tool.ts`:

| Tool | Literal site |
|---|---|
| `@opensip-tools/fitness` | `packages/fitness/engine/src/tool.ts:285` — `version: '1.0.0'` |
| `@opensip-tools/simulation` | `packages/simulation/engine/src/tool.ts:94` — `version: '1.0.0'` |
| `@opensip-tools/graph` | `packages/graph/engine/src/tool.ts:72` — `version: '1.0.10'` |

The release process bumps `package.json` versions across the workspace (17+ packages) with a single `pnpm -r ... npm version` command. The literal strings in `tool.ts` are not touched. They drift silently.

The release-consistency gate (`tools/verify-release.mjs`) catches workspace-level disagreement between *package.json* files (check #1), but cannot see the literals inside source code. Only `graph` has a contract test that catches the drift — and only because the parent code-explorer agent noticed and filed it during a parallel-agent run:

```
FAIL  src/__tests__/tool.test.ts > graphTool contract conformance (AC-2) > metadata.version matches package.json
AssertionError: expected '1.0.5' to be '1.0.10'
```

`fitness` and `simulation` would not have caught a 1.0.0 → 1.0.10 release-drift because they don't have the same test. Their `metadata.version` has presumably been wrong for several releases and nobody noticed because nothing depends on it being correct.

## 2. Why it matters

`metadata.version` is part of the Tool contract — the value shows up in any consumer that lists installed tools, in dashboards, in plugin-discovery diagnostics, and (via the registry) in JSON output that downstream systems may parse. A version field that drifts silently from the real package version is a low-grade integrity bug: it's not catastrophic, but it makes debugging "which version of the tool ran?" much harder for anyone trying to reproduce a problem.

The current shape also makes the Tool contract harder to teach. A third-party plugin author writing their own Tool reads three first-party examples, sees hardcoded version literals, and copies that pattern. The third-party tool then drifts the same way.

## 3. Proposed fix

Read the version from `package.json` once, at module load time, the same way the CLI already does for `PKG_VERSION` (`packages/cli/src/index.ts:114-123`):

```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const graphTool: Tool = {
  metadata: {
    id: 'graph',
    version: readPkgVersion(),
    description: 'Static call-graph + dead-end analysis',
  },
  commands: [GRAPH],
  register,
};
```

A small shared helper in `@opensip-tools/core` would let each tool write one line instead of seven. The helper takes the calling module's `import.meta.url` and walks up to the nearest `package.json`. Pseudocode:

```typescript
// @opensip-tools/core
export function readPackageVersion(metaUrl: string): string { ... }

// each tool
metadata: {
  id: 'graph',
  version: readPackageVersion(import.meta.url),
  ...
}
```

## 4. Acceptance criteria

1. `fitness`, `simulation`, and `graph` each report a `metadata.version` that equals their own `package.json` `version`, verified by a contract test in each (the test already exists for `graph` — extend the pattern to the other two).
2. Bumping a workspace package version via the standard release process (`pnpm -r ... npm version patch`) updates the tool's `metadata.version` automatically, with no source-code edit required.
3. The release-consistency gate (`tools/verify-release.mjs`) does NOT need a new check — the per-tool contract tests are the right level for this enforcement.

## 5. Out of scope

- Reading other `package.json` fields (description, license, author) the same way. Could come later if useful; right now `metadata.description` is hand-authored and doesn't drift.
- Third-party tools — they can adopt the same pattern voluntarily, but enforcement only applies to first-party tools.
- Renaming `metadata.version` to clarify its semantics (implementation version vs. schema version). The current single-version model is fine until a tool actually needs to version its output schema independently.
