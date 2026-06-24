/**
 * @fileoverview The CLI host must not statically import a tool RUNTIME (§1, 3.0.0).
 *
 * Install-source independence (north-star §1) requires the host to load bundled
 * tools through the SAME dynamic-import plugin path an installed tool uses — never
 * a static `import { fitnessTool } from '@opensip-cli/fitness'`. Importing a
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
 *
 * WAIVED placement exception (the `//` directive below is what the suppressor
 * reads): this is an opensip-internal dogfood check, but it is the one relocation
 * that genuinely needs the TS-AST substrate (@opensip-cli/lang-typescript
 * `getSharedSourceFile`) — it must tell a REAL `import { fitnessTool }` from the
 * same symbol appearing as TEXT inside `init` scaffold template literals, which a
 * raw-regex project-local .mjs cannot (the module-specifier string can't be
 * stripped without losing import detection). `@opensip-cli/lang-*` is not
 * resolvable from `opensip-cli/fit/checks/`, so it stays SHIPPED until lang-* is
 * root-resolvable for project-local checks (then relocate it).
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- AST-dependent dogfood check; needs @opensip-cli/lang-typescript, which a project-local .mjs cannot import. See header.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** The CLI host source tree this check guards (the loader + composition root). */
const CLI_HOST_PATH = 'packages/cli/src/';

/** Tool packages whose runtime export must not be statically imported by the host. */
const TOOL_PACKAGE_RE = /^@opensip-cli\/(?:fitness|graph|simulation)(?:\/.*)?$/;

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
