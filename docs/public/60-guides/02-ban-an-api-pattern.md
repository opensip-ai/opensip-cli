---
status: current
last_verified: 2026-06-12
release: v0.1.13
title: "Ban an API pattern"
audience: [plugin-authors, getting-started]
purpose: "Task-led: write a check that flags every use of a specific API — covering the regex shape, the AST shape, and the trade-offs between them."
source-files:
  - packages/fitness/engine/src/framework/define-check.ts
  - packages/languages/lang-typescript/src/index.ts
related-docs:
  - ./01-write-your-first-check.md
  - ../50-extend/01-plugin-authoring.md
  - ../20-fit/01-recipes-and-checks.md
---
# Ban an API pattern

This is the single most common reason teams adopt opensip: *"I want to fail CI when anyone uses X."* The X is usually a deprecated function, an unsafe primitive, a private/internal API that leaked, or a slow path you've already deprecated in the docs.

This guide uses **`crypto.createCipher`** as the running example. It's a real-world ban shape: `createCipher` is a legacy, unsafe API family (no IV, MD5-based KDF), and the safer replacement is `crypto.createCipheriv()`. Banning the deprecated form in your codebase is exactly the kind of architectural rule opensip-cli exists to enforce.

We'll write the ban two ways: with a regex (5 minutes, works for ~80% of cases) and with the TypeScript AST (a bit more code, catches the cases regex misses).

## The regex version

When the API name is distinctive enough that you can grep for it, a regex check is sharp and tiny.

Create `opensip-cli/fit/checks/no-create-cipher.mjs`:

```js
import { defineCheck } from '@opensip-cli/fitness';

export default defineCheck({
  id: '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b',
  slug: 'no-create-cipher',
  description: 'Disallow crypto.createCipher (legacy unsafe API). Use createCipheriv instead.',
  tags: ['security', 'deprecated-api'],
  scope: { languages: ['typescript'], concerns: [] },
  // Strip strings + comments so the check doesn't false-positive on
  // a comment that mentions `createCipher` or a string literal.
  contentFilter: 'strip-strings-and-comments',

  analyze(content, filePath) {
    const violations = [];
    const pattern = /\bcreateCipher\s*\(/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      // Count line number by scanning newlines before the match
      const line = content.slice(0, match.index).split('\n').length;
      violations.push({
        line,
        message: 'Use crypto.createCipheriv(); createCipher is a legacy unsafe API.',
        severity: 'error',
      });
    }
    return violations;
  },
});
```

Three things worth noting:

- **`contentFilter: 'strip-strings-and-comments'`** — `content` arrives with all JS string literals and comments replaced by whitespace of equal length. Line numbers are preserved, but the regex won't match `"// avoid createCipher"` or `const example = 'createCipher'`. This is the right default for any pattern-shaped check.
- **`severity: 'error'`** — fails the run with exit code 1. Use `'warning'` for advisory checks.
- **The pattern uses `\b...\(`** — anchors on word-boundary + open-paren, so it doesn't match `createCipherIv` or a variable named `createCipher` (without a call).

Run it:

```bash
opensip fit --check no-create-cipher --verbose
```

## When regex isn't enough

The regex catches `createCipher(...)`. It misses:

- `const c = crypto.createCipher; c(...)` — assigned to a variable then called
- Aliased imports: `import { createCipher as makeCipher } from 'crypto'`
- Property access through dynamic keys: `crypto['createCipher']`
- Re-exports through a wrapper module

If those cases matter, you want an AST-driven check. The TypeScript-AST helpers live in `@opensip-cli/lang-typescript`:

```js
import { defineCheck } from '@opensip-cli/fitness';
import { getSharedSourceFile, walkNodes } from '@opensip-cli/lang-typescript';

export default defineCheck({
  id: '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c',
  slug: 'no-create-cipher-ast',
  description: 'Disallow crypto.createCipher (AST-based — catches aliases and indirection)',
  tags: ['security', 'deprecated-api'],
  scope: { languages: ['typescript'], concerns: [] },

  analyze(content, filePath) {
    const violations = [];
    const sf = getSharedSourceFile(filePath, content);

    walkNodes(sf, (node) => {
      // Direct call: createCipher(...) or crypto.createCipher(...)
      if (node.kind === /* ts.SyntaxKind.CallExpression */ 213) {
        const expr = node.expression;
        const name = expr.name?.escapedText ?? expr.escapedText;
        if (name === 'createCipher') {
          violations.push({
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            message: 'Use crypto.createCipheriv(); createCipher is a legacy unsafe API.',
            severity: 'error',
          });
        }
      }
    });

    return violations;
  },
});
```

The AST version catches `crypto.createCipher(...)`, `createCipher(...)` (post-import), and aliased imports if you walk the import map (omitted here for brevity — see `findEnclosingScope` and `getPropertyChain` in `@opensip-cli/lang-typescript`).

**Pick one, not both.** Regex is faster to write and faster to run. AST is more robust. For a banned-API check, regex usually wins; the cases AST catches are rare enough that a code-review catches them too. The exception: if the API name is a common English word (`load`, `process`, `run`), AST is the only way to avoid false positives.

## Add to a recipe

Once the check is in `opensip-cli/fit/checks/`, it auto-loads. To group it with other deprecated-API bans:

```js
// opensip-cli/fit/recipes/deprecated-apis.mjs
export const recipes = [{
  id: 'URCP_deprecated_apis',
  name: 'deprecated-apis',
  displayName: 'Deprecated APIs',
  description: 'Bans for APIs that should not appear in new code',
  checks: { type: 'tags', include: ['deprecated-api'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
```

Run with `opensip fit --recipe deprecated-apis`.

## Adopting an existing-violation ban

If the codebase already has uses of the banned API, gating on "all violations" blocks every PR until cleanup is done. Use the baseline flow instead:

```bash
opensip fit --recipe deprecated-apis --gate-save     # captures current state
opensip fit --recipe deprecated-apis --gate-compare  # fails only on *new* uses
```

You can fix the baseline cases over time. New PRs are blocked from adding fresh violations from day one. Full walkthrough in [wire into CI](./03-wire-into-ci.md) and [adopt in a monorepo](./04-adopt-in-a-monorepo.md).

## Where to go next

| You want to … | Go to … |
|---|---|
| Walk the full check API surface | [Plugin authoring](../50-extend/01-plugin-authoring.md) |
| Add the GitHub Actions step | [Wire into CI](./03-wire-into-ci.md) |
| See every built-in security/deprecation check | [Checks reference](../70-reference/05-checks-index.md) |
