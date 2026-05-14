# Phase 5: Python, Java, Go language packs

**Goal:** Apply the Phase 3 template (Rust) three more times: ship `@opensip-tools/lang-python`, `@opensip-tools/lang-java`, `@opensip-tools/lang-go`, each with a minimal "hello world" check pack. The three packs are independent of each other and can be built in parallel by three contributors.
**Depends on:** Phase 3

This phase is intentionally mechanical. Each language follows the same task list as Phase 3 with parser- and idiom-specific substitutions. Do NOT re-litigate the design here — copy the structure.

Task order within each language: scaffold packages -> grammar loader -> adapter + parse -> query API -> strip-strings/comments -> proof check -> CLI fixture run. Languages can proceed in any order or in parallel.

---

## Task 5.1: `@opensip-tools/lang-python` + `@opensip-tools/checks-python`

**Files:** [size: M]
- Create: `packages/lang-python/package.json`, `tsconfig.json`, `src/{index,adapter,parse,query,strip,grammar-loader}.ts`
- Create: `packages/checks-python/package.json`, `tsconfig.json`, `src/{index}.ts`, `src/checks/no-bare-except.ts`
- Create: `packages/cli/__fixtures__/multi-lang/sample.py`

**Context:** Python parser is `tree-sitter-python`. File extensions `.py`, `.pyi`. Comments are `#` (single-line) and triple-quoted strings (docstrings — NOT lexical comments but commonly treated as such). String literals: `"..."`, `'...'`, `"""..."""`, `'''...'''`, plus the `r"..."` / `f"..."` / `b"..."` prefixes.

Proof check: **no-bare-except** — flags `except:` clauses (without exception type), which silently swallow all exceptions. Tree-sitter node: `except_clause`. Match when the clause has no value expression for its exception type.

**Idiom differences to track in this adapter:**
- Python docstrings are string literals, not comments. `stripComments` should leave them alone (or treat them as strings under `stripStrings`).
- The `f"..."` interpolated strings contain expression nodes inside — treat the whole literal as a string for `stripStrings` purposes; do not recurse into interpolations.
- F-strings are `string` with internal `interpolation` nodes in tree-sitter-python's grammar. Replace the outer range with whitespace, accept the loss of interpolation precision.

**Steps:**

1. Scaffold both packages following Phase 3 Task 3.1 shape, substituting `python` / `Python` / `tree-sitter-python`.
2. Grammar loader follows Phase 3 Task 3.2 — substitute `tree-sitter-python/tree-sitter-python.wasm` for the WASM path.
3. Adapter follows Phase 3 Task 3.3:
   - `id: 'python'`, `fileExtensions: ['.py', '.pyi']`, `aliases: ['py']`.
4. Query API (Phase 3 Task 3.4) — substitute node types:
   - Functions: `function_definition`, `lambda`
   - Imports: `import_statement`, `import_from_statement` (extract `module_name`/`dotted_name`/`aliased_import` children for the specifier and names)
   - Calls: `call` (function node accessed via `childForFieldName('function')`)
   - String literals: `string` (skip nested `interpolation` children)
5. Strip (Phase 3 Task 3.5) — node types `string`, `comment`.
6. Proof check `no-bare-except`:
   ```typescript
   import { defineCheck, type CheckViolation } from '@opensip-tools/core'
   import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
   import { pythonAdapter } from '@opensip-tools/lang-python'

   export const noBareExcept = defineCheck({
     id: 'd1e2f3a4-b5c6-7890-abcd-ef0123456789',
     slug: 'python-no-bare-except',
     description: 'Disallow bare except: clauses — catch specific exception types instead',
     scope: { languages: ['python'], concerns: ['backend'] },
     tags: ['quality', 'python'],
     fileTypes: ['.py'],
     analyze: (content, filePath) => {
       const tree = getParseTree(pythonAdapter, filePath, content)
       if (!tree) return []
       const violations: CheckViolation[] = []
       const walk = (n: any): void => {
         if (n.type === 'except_clause') {
           const hasValue = (() => {
             for (let i = 0; i < n.childCount; i++) {
               const c = n.child(i)
               if (c && c.type !== 'except' && c.type !== ':' && c.type !== 'block') return true
             }
             return false
           })()
           if (!hasValue) {
             violations.push({
               line: n.startPosition.row + 1,
               column: n.startPosition.column,
               message: 'Bare except: catches everything including KeyboardInterrupt — name the exception type',
               severity: 'warning',
             })
           }
         }
         for (let i = 0; i < n.childCount; i++) {
           const c = n.child(i)
           if (c) walk(c)
         }
       }
       walk(tree.rootNode)
       return violations
     },
   })
   ```
7. Fixture `sample.py`:
   ```python
   def main():
       try:
           open("foo").read()
       except:
           pass
   ```
8. Add a vitest end-to-end test mirroring `multi-lang-rust.test.ts` from Phase 3 Task 3.7.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-python test
pnpm --filter=@opensip-tools/checks-python test
```

**Commit:** `feat(lang-python,checks-python): Python adapter + no-bare-except proof check`

---

## Task 5.2: `@opensip-tools/lang-java` + `@opensip-tools/checks-java`

**Files:** [size: M]
- Create: `packages/lang-java/**` (same shape as lang-python)
- Create: `packages/checks-java/**`
- Create: `packages/cli/__fixtures__/multi-lang/Sample.java`

**Context:** Java parser is `tree-sitter-java`. File extensions `.java`. Comments are `//`, `/* */`, and Javadoc `/** */` (which is just a block comment by lexing). String literals: `"..."`, plus Java 13+ text blocks `"""..."""`. No raw strings.

Proof check: **no-system-out-println** — flags `System.out.println(...)` calls. Tree-sitter node walk: find `method_invocation` whose `object` is a `field_access` chain `System.out` and whose `name` is `println`.

**Idiom differences:**
- Java has packages (`package com.foo;`) which appear at the top of every file but aren't imports per se. Treat them as a separate concept; the query API's `findImports` returns Java `import` statements only.
- Static imports (`import static java.util.Arrays.asList;`) are imports too — include them.
- Text blocks `"""..."""` are strings; `stripStrings` must handle them.

**Steps:**

1. Scaffold packages.
2. Grammar loader — substitute `tree-sitter-java/tree-sitter-java.wasm`.
3. Adapter: `id: 'java'`, `fileExtensions: ['.java']`.
4. Query API node types:
   - Functions: `method_declaration`, `constructor_declaration`, `lambda_expression`
   - Imports: `import_declaration`
   - Calls: `method_invocation`
   - String literals: `string_literal`, `text_block`
5. Strip — node types `string_literal`, `text_block`, `line_comment`, `block_comment`.
6. Proof check `no-system-out-println`.
7. Fixture `Sample.java`:
   ```java
   public class Sample {
       public static void main(String[] args) {
           System.out.println("hello");
       }
   }
   ```
8. End-to-end test.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-java test
pnpm --filter=@opensip-tools/checks-java test
```

**Commit:** `feat(lang-java,checks-java): Java adapter + no-system-out-println proof check`

---

## Task 5.3: `@opensip-tools/lang-go` + `@opensip-tools/checks-go`

**Files:** [size: M]
- Create: `packages/lang-go/**`
- Create: `packages/checks-go/**`
- Create: `packages/cli/__fixtures__/multi-lang/sample.go`

**Context:** Go parser is `tree-sitter-go`. File extensions `.go`. Comments `//` and `/* */`. String literals: `"..."`, raw strings `` `...` ``, char literals `'x'`. No string interpolation.

Proof check: **no-fmt-println** — flags `fmt.Println(...)` calls outside main / debug contexts. Tree-sitter node: `call_expression` whose function is a `selector_expression` with `operand.text === 'fmt'` and `field.text === 'Println'`.

**Idiom differences:**
- Go has both `// line` and `/* block */` comments. Block comments don't nest (unlike Rust).
- Raw strings (backticks) span newlines; tree-sitter's `raw_string_literal` covers this.
- Go's `import` statements come in two shapes: single `import "fmt"` and grouped `import ( ... )`. Handle both — the grouped form has child `import_spec` nodes.

**Steps:**

1. Scaffold packages.
2. Grammar loader — substitute `tree-sitter-go/tree-sitter-go.wasm`.
3. Adapter: `id: 'go'`, `fileExtensions: ['.go']`.
4. Query API node types:
   - Functions: `function_declaration`, `method_declaration`, `func_literal`
   - Imports: `import_declaration` (walk child `import_spec` nodes)
   - Calls: `call_expression`
   - String literals: `interpreted_string_literal`, `raw_string_literal`
5. Strip — node types `interpreted_string_literal`, `raw_string_literal`, `comment`.
6. Proof check `no-fmt-println`.
7. Fixture `sample.go`:
   ```go
   package main

   import "fmt"

   func main() {
       fmt.Println("hello")
   }
   ```
8. End-to-end test.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-go test
pnpm --filter=@opensip-tools/checks-go test
```

**Commit:** `feat(lang-go,checks-go): Go adapter + no-fmt-println proof check`

---

## Phase 5 End-to-End Verification

After all three tasks:

```bash
pnpm build && pnpm typecheck && pnpm test
```

Each fixture under `packages/cli/__fixtures__/multi-lang/` should trigger its proof check when run through the integration test. No language pack should interfere with another — registering all three (plus Rust and TS) concurrently must work.

Smoke run (assumes all five lang packs registered via plugin domain):
```bash
cd packages/cli/__fixtures__/multi-lang
opensip-tools fit
```

Expected: five violations total — one from each `.rs`/`.py`/`.java`/`.go`/`.ts` file (the TS file is set up by Phase 9; for now it may be absent).
