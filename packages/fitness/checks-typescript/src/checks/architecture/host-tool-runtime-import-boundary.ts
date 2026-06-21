/**
 * @fileoverview Keep ADR-0054's host-process runtime import exception narrow.
 *
 * External Tool runtimes still execute in the host process during the
 * ADR-0054 migration because the current manifest only carries command
 * metadata, not executable CommandSpec/RPC descriptors. That exception must
 * remain explicit: every importToolRuntime call needs a source policy, and no
 * new production call sites should appear outside the admission/discovery
 * boundary OR the worker-owned dispatch plane.
 *
 * The worker entry (`tool-command-worker-entry.ts`) is a sanctioned call site:
 * it runs in the FORKED worker process, not the host — importing the untrusted
 * runtime there is the ADR-0054 isolation goal, not a host-process import. It is
 * allowlisted alongside the admission/discovery boundary; both still require an
 * explicit source policy so external runtime execution stays visible.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- dogfood check for this repo's ADR-0054 migration boundary; AST precision keeps the temporary import exception mechanically narrow.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const CLI_HOST_PATH = 'packages/cli/src/';
const IMPORT_RUNTIME = 'importToolRuntime';
const POLICY_HELPER = 'hostRuntimeImportPolicyFor';

const ALLOWED_CALLSITE_SUFFIXES = new Set([
  'packages/cli/src/bootstrap/admit-tool-package.ts',
  'packages/cli/src/bootstrap/register-tools.ts',
  'packages/cli/src/bootstrap/register-tools-discovery.ts',
  // ADR-0054 worker-owned dispatch plane: this entry runs in the FORKED worker
  // process (not the host), so importing the external runtime here is the
  // isolation goal. Still requires an explicit source policy.
  'packages/cli/src/bootstrap/tool-command-worker-entry.ts',
]);

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function isAllowedCallsite(filePath: string): boolean {
  const p = normalized(filePath);
  for (const suffix of ALLOWED_CALLSITE_SUFFIXES) {
    if (p.endsWith(suffix)) return true;
  }
  return false;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function isTrueLiteral(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.TrueKeyword;
}

function isPolicyArg(arg: ts.Expression): boolean {
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
    return arg.expression.text === POLICY_HELPER;
  }
  if (!ts.isObjectLiteralExpression(arg)) return false;

  let hasSource = false;
  let hasTransition = false;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyNameText(prop.name);
    if (name === 'source') hasSource = true;
    if (name === 'adr0054Transition' && isTrueLiteral(prop.initializer)) {
      hasTransition = true;
    }
  }
  return hasSource && (hasTransition || arg.getText().includes("'bundled'"));
}

function localRuntimeImportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = stmt.moduleSpecifier.text;
    if (!module.endsWith('/admit-tool-package.js') && module !== './admit-tool-package.js') {
      continue;
    }
    const named = stmt.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === IMPORT_RUNTIME) names.add(element.name.text);
    }
  }
  // The defining module calls its own exported function by name.
  if (isAllowedCallsite(sourceFile.fileName)) names.add(IMPORT_RUNTIME);
  return names;
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeHostToolRuntimeImportBoundary(
  content: string,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const runtimeNames = localRuntimeImportNames(sourceFile);
  if (runtimeNames.size === 0) return violations;

  const allowedFile = isAllowedCallsite(filePath);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (runtimeNames.has(callee)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (!allowedFile) {
          violations.push({
            message:
              `importToolRuntime may only be called from the tool admission/discovery boundary ` +
              `(ADR-0054 transition). Found host-process runtime import in ${normalized(filePath)}.`,
            severity: 'error',
            line,
            suggestion:
              'Route tool runtime loading through admit-tool-package/register-tools, or the ADR-0054 worker boundary.',
          });
        } else if (node.arguments.length < 2 || !isPolicyArg(node.arguments[1])) {
          violations.push({
            message:
              'importToolRuntime host-process imports must pass an explicit source policy ' +
              '(bundled or adr0054Transition) so external runtime execution remains visible.',
            severity: 'error',
            line,
            suggestion:
              'Pass hostRuntimeImportPolicyFor(source), or an explicit policy object for bundled/ADR-0054 transition imports.',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const hostToolRuntimeImportBoundary = defineCheck({
  id: 'b7554963-e24e-4d80-b3e0-edbb97bbdba3',
  slug: 'host-tool-runtime-import-boundary',
  description:
    'Host-process tool runtime imports must stay in the admission boundary and carry an explicit ADR-0054 transition policy',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    if (!normalized(filePath).includes(CLI_HOST_PATH) || isTestFile(filePath)) return [];
    return analyzeHostToolRuntimeImportBoundary(content, filePath);
  },
});
