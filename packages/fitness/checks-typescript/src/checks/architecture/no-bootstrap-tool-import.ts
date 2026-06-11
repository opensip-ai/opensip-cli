/**
 * @fileoverview The CLI host must not statically import a tool RUNTIME (§1, 3.0.0).
 *
 * Install-source independence (north-star §1) requires the host to load bundled
 * tools through the SAME dynamic-import plugin path an installed tool uses — never
 * a static `import { fitnessTool } from '@opensip-tools/fitness'`. Importing a
 * tool-runtime export (`fitnessTool` / `graphTool` / `simulationTool`) compiles the
 * tool into the CLI and re-privileges its load path — the exact coupling the
 * acceptance test deletes. Bundled tools are named in `BUNDLED_TOOL_PACKAGES` and
 * loaded by `importToolRuntime` (`bootstrap/register-tools.ts`). This is the
 * mechanical guarantee behind completion invariant 1 (§8).
 *
 * The check is PRECISE — it flags only the tool-RUNTIME symbols, so legitimate
 * host couplings to a tool package's NON-runtime API are untouched: graph's
 * adapter-discovery (`register-graph-adapters.ts` imports
 * `discoverGraphAdapterPackages` / `GraphLanguageAdapter`) and fitness's
 * `defineCheck` authoring API are different concerns, not the runtime-load
 * privilege. AST-based, so a tool-runtime symbol appearing as TEXT inside a
 * template literal (e.g. the `init` scaffolds in `config-templates.ts`, which
 * EMIT user-project source) is correctly ignored — it is not a real import
 * declaration. Test code (`__tests__/`) is exempt: a white-box test may import a
 * tool runtime directly (see `cli/.../__tests__/test-utils/bundled-tools.ts`).
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness';
import { getSharedSourceFile } from '@opensip-tools/lang-typescript';
import * as ts from 'typescript';

/** The CLI host source tree this check guards (the loader + composition root). */
const CLI_HOST_PATH = 'packages/cli/src/';

/** Tool packages whose runtime export must not be statically imported by the host. */
const TOOL_PACKAGE_RE = /^@opensip-tools\/(?:fitness|graph|simulation)(?:\/.*)?$/;

/** The tool-RUNTIME exports — importing any of these is the load-path privilege. */
const TOOL_RUNTIME_SYMBOLS: ReadonlySet<string> = new Set([
  'fitnessTool',
  'graphTool',
  'simulationTool',
]);

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeBootstrapToolImport(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!TOOL_PACKAGE_RE.test(stmt.moduleSpecifier.text)) continue;
    const named = stmt.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      // The ORIGINAL imported name (`{ graphTool as gt }` → `graphTool`).
      const imported = (element.propertyName ?? element.name).text;
      if (!TOOL_RUNTIME_SYMBOLS.has(imported)) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
      violations.push({
        message:
          `The CLI host must not statically import the tool runtime '${imported}' from ` +
          `'${stmt.moduleSpecifier.text}' (§1): bundled tools load through the dynamic plugin ` +
          `path, so install-source independence stays structural. A static import re-privileges ` +
          `the bundled load path.`,
        severity: 'error',
        line,
        suggestion:
          'Load bundled tools via BUNDLED_TOOL_PACKAGES + importToolRuntime ' +
          '(bootstrap/register-tools.ts). Test code may import a tool runtime directly.',
      });
    }
  }
  return violations;
}

export const noBootstrapToolImport = defineCheck({
  id: 'c7e4a1f2-3b6d-4e08-9a51-2f8c4d0b7e93',
  slug: 'no-bootstrap-tool-import',
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
