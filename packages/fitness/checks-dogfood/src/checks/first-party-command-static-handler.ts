/**
 * @fileoverview First-party command specs must declare staticHandler metadata.
 *
 * ADR-0154: runtime wiring bridges author-declared handler identities to graph
 * declaration facts. Every first-party leaf authored with defineCommand /
 * definePrimaryCommand / defineNestedCommand / definePrimaryRunCommand that
 * mounts a handler must carry a three-field staticHandler claim
 * (package + project-relative POSIX path + declaration). Missing metadata
 * silently degrades bridge coverage.
 *
 * defineAnalysisRunCommand is contracts-owned with a fixed descriptor and is
 * excluded from direct-source enforcement. Action-less groups, tests, and
 * installed/authored packages are ignored. Runtime CommandSpec validation
 * remains authoritative for path normalization and unknown-key rejection.
 *
 * Path-gated to first-party CLI and bundled Tool packages only.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const FACTORY_NAMES = new Set([
  'defineCommand',
  'definePrimaryCommand',
  'defineNestedCommand',
  'definePrimaryRunCommand',
]);

/** Production roots that must declare staticHandler on command factories. */
const FIRST_PARTY_ROOTS = [
  'packages/cli/src/',
  'packages/graph/engine/src/',
  'packages/fitness/engine/src/',
  'packages/simulation/engine/src/',
  'packages/yagni/engine/src/',
  'packages/mcp/src/',
  'packages/external-tool-adapter/src/',
] as const;

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function inFirstPartyRoot(filePath: string): boolean {
  const n = normalized(filePath);
  return FIRST_PARTY_ROOTS.some((root) => n.includes(root));
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function hasHandler(obj: ts.ObjectLiteralExpression): boolean {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyNameText(prop.name) === 'handler') return true;
    if (ts.isMethodDeclaration(prop) && propertyNameText(prop.name) === 'handler') return true;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'handler') return true;
  }
  return false;
}

function hasStaticHandler(obj: ts.ObjectLiteralExpression): boolean {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || propertyNameText(prop.name) !== 'staticHandler') {
      continue;
    }
    if (!ts.isObjectLiteralExpression(prop.initializer)) return false;
    const keys = new Set<string>();
    for (const field of prop.initializer.properties) {
      if (!ts.isPropertyAssignment(field)) continue;
      const name = propertyNameText(field.name);
      if (name !== undefined) keys.add(name);
    }
    return keys.has('package') && keys.has('path') && keys.has('declaration');
  }
  return false;
}

function collectFactoryBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (
      mod.text !== '@opensip-cli/core' &&
      mod.text !== '@opensip-cli/contracts' &&
      !mod.text.endsWith('/command-presets.js')
    ) {
      continue;
    }
    const named = stmt.importClause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (FACTORY_NAMES.has(imported)) bindings.add(el.name.text);
    }
  }
  return bindings;
}

function callFactoryName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }
  return undefined;
}

/** First-party command factories must declare staticHandler for audit bridging (ADR-0154). */
export const firstPartyCommandStaticHandler = defineCheck({
  id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
  slug: 'first-party-command-static-handler',
  description:
    'First-party defineCommand/definePrimaryCommand/defineNestedCommand/definePrimaryRunCommand leaves with handlers must declare staticHandler metadata (ADR-0154)',
  scope: { languages: ['typescript'], concerns: ['cli', 'tools'] },
  tags: ['architecture', 'dogfood'],
  analyze: (content, filePath) => {
    if (isTestFile(filePath) || !inFirstPartyRoot(filePath)) return [];
    if (normalized(filePath).includes('/__fixtures__/')) return [];
    // Generated third-party scaffolds are not first-party leaves.
    if (normalized(filePath).includes('create-templates.ts')) return [];

    const sourceFile = getSharedSourceFile(filePath, content);
    if (sourceFile === null) return [];
    const bindings = collectFactoryBindings(sourceFile);
    if (bindings.size === 0) return [];

    const violations: CheckViolation[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = callFactoryName(node.expression);
        // Match through import bindings / aliases only — not bare local functions.
        if (name !== undefined && bindings.has(name) && node.arguments.length > 0) {
          const arg0 = node.arguments[0];
          if (arg0 !== undefined && ts.isObjectLiteralExpression(arg0) && hasHandler(arg0)) {
            if (!hasStaticHandler(arg0)) {
              const line =
                sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
              violations.push({
                message:
                  `First-party command factory '${name}' mounts a handler without staticHandler ` +
                  `{ package, path, declaration }. Runtime wiring cannot bridge this leaf.`,
                severity: 'error',
                line,
                suggestion:
                  'Add staticHandler with the exact workspace package name, project-root-relative ' +
                  'POSIX path, and declaration name. defineAnalysisRunCommand is excluded ' +
                  '(contracts-owned fixed descriptor). See ADR-0154.',
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return violations;
  },
});
