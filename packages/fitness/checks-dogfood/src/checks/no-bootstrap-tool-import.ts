/**
 * @fileoverview The CLI host must not statically import a tool RUNTIME (§1, 3.0.0).
 *
 * Install-source independence (north-star §1) requires the host to load bundled
 * tools through the SAME dynamic-import plugin path an installed tool uses — never
 * a static `import { fitnessTool } from '@opensip-cli/fitness'`. Importing a
 * tool-runtime export compiles the tool into the CLI and re-privileges its load
 * path — the exact coupling the acceptance test deletes.
 *
 * AUTHORITY: dependency-cruiser's manifest-derived `cli-no-static-tool-package-import`
 * rule (ADR-0151) is the complete, fail-closed gate — it covers a Tool with ANY
 * package name because it is manifest-derived. THIS dogfood check is a
 * current-package SOURCE DIAGNOSTIC: it emits an actionable file/line finding for
 * every import FORM of a currently-known Tool runtime (named `tool`/`*Tool` from a
 * first-party package, plus default/namespace/side-effect imports of a Tool-family
 * package), before the structural gate runs. It intentionally does NOT maintain a
 * second manifest inventory.
 *
 * PRECISE: `import type` declarations and inline `type` specifiers are exempt (no
 * runtime load). AST-based, so a tool-runtime symbol appearing as TEXT inside a
 * template literal (e.g. the `init` scaffolds in `config-templates.ts`, which EMIT
 * user-project source) is ignored — not a real import. Test code (`__tests__/`) is
 * exempt: a white-box test may import a tool runtime directly.
 *
 * WAIVED placement exception (the `//` directive below is what the suppressor
 * reads): this is an opensip-internal dogfood check, but it is the one relocation
 * that genuinely needs the TS-AST substrate (@opensip-cli/lang-typescript
 * `getSharedSourceFile`) — it must tell a REAL `import { fitnessTool }` from the
 * same symbol appearing as TEXT inside `init` scaffold template literals, which a
 * raw-regex project-local .mjs cannot. `@opensip-cli/lang-*` is not resolvable
 * from `opensip-cli/fit/checks/`, so it stays SHIPPED until lang-* is
 * root-resolvable for project-local checks (then relocate it).
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- AST-dependent dogfood check; needs @opensip-cli/lang-typescript, which a project-local .mjs cannot import. See header.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** The CLI host source tree this check guards (the loader + composition root). */
const CLI_HOST_PATH = 'packages/cli/src/';

/** Tool-family packages: the five bundled roots + external scanner adapters.
 * A `tool`/`*Tool` named import, or a default/namespace/side-effect import, of
 * one of these loads the tool runtime. Scoping the name heuristic to Tool-family
 * packages avoids false positives on core helpers that also end in `Tool`
 * (`defineTool`, `admitTool`, `assertManifestMatchesTool`). dependency-cruiser's
 * manifest-derived rule remains authoritative for a Tool with any package name. */
const TOOL_PACKAGE_RE =
  /^@opensip-cli\/(?:fitness|graph|simulation|yagni|mcp|tool-[a-z0-9-]+)(?:\/.*)?$/;

/** A Tool runtime export is conventionally `tool` (the generic alias) or `*Tool`. */
function isToolRuntimeName(name: string): boolean {
  return name === 'tool' || /Tool$/.test(name);
}

function violation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  detail: string,
  specifier: string,
): CheckViolation {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return {
    message:
      `The CLI host must not statically import a tool runtime (${detail}) from '${specifier}' (§1): ` +
      `bundled tools load through the dynamic plugin path, so install-source independence stays ` +
      `structural. A static import re-privileges the bundled load path.`,
    severity: 'error',
    line,
    suggestion:
      'Load bundled tools via BUNDLED_TOOL_PACKAGES + importToolRuntime ' +
      '(bootstrap/register-tools.ts). Test code may import a tool runtime directly.',
  };
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeBootstrapToolImport(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;

    // Side-effect import (`import '@opensip-cli/graph';`) — no clause; loads the
    // runtime. Only meaningful for a Tool-family package.
    if (clause === undefined) {
      if (TOOL_PACKAGE_RE.test(specifier)) {
        violations.push(violation(sourceFile, stmt, 'side-effect import', specifier));
      }
      continue;
    }

    // `import type { ... }` / `import type X` — no runtime load.
    if (clause.isTypeOnly) continue;

    const isToolFamily = TOOL_PACKAGE_RE.test(specifier);
    // Only Tool-family packages carry runtime imports; skip everything else
    // (e.g. core helpers named `*Tool`) — depcruise is the manifest-complete gate.
    if (!isToolFamily) continue;

    // Default import (`import graphTool from ...`) loads the runtime.
    if (clause.name !== undefined) {
      violations.push(
        violation(sourceFile, clause.name, `default import '${clause.name.text}'`, specifier),
      );
    }

    const named = clause.namedBindings;
    if (named === undefined) continue;

    // Namespace import (`import * as graph from ...`) loads the runtime.
    if (ts.isNamespaceImport(named)) {
      violations.push(
        violation(sourceFile, named.name, `namespace import '${named.name.text}'`, specifier),
      );
      continue;
    }

    // Named imports: a `tool`/`*Tool` value specifier is a Tool runtime
    // (aliases resolve via propertyName).
    if (ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue; // inline `type` specifier — no runtime.
        const imported = (element.propertyName ?? element.name).text;
        if (!isToolRuntimeName(imported)) continue;
        violations.push(violation(sourceFile, element, `tool runtime '${imported}'`, specifier));
      }
    }
  }
  return violations;
}

export const noBootstrapToolImport = defineCheck({
  id: '09453917-4f95-446d-a6d1-3a5445b00902',
  slug: 'no-bootstrap-tool-import',
  contentFilter: 'raw',
  description:
    'The CLI host must not statically import a tool runtime — bundled tools load via the dynamic plugin path (§1 install-source independence)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    if (!filePath.includes(CLI_HOST_PATH) || isTestFile(filePath)) return [];
    return analyzeBootstrapToolImport(content, filePath);
  },
});
