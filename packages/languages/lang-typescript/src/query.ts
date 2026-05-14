import ts from 'typescript'

import type { LanguageQueryAPI } from '@opensip-tools/core/languages/adapter.js'
import type { GenericFunction, Import, Location } from '@opensip-tools/core/languages/generic-types.js'

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): Location {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { file: sourceFile.fileName, line: line + 1, column: character }
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

export const typescriptQuery: LanguageQueryAPI<ts.SourceFile, ts.Node> = {
  findFunctions(tree) {
    const out: GenericFunction<ts.Node>[] = []
    walk(tree, (n) => {
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n)
      ) {
        const name = (n as ts.FunctionDeclaration).name?.text ?? null
        out.push({ name, location: locationOf(tree, n), node: n })
      }
    })
    return out
  },
  findImports(tree) {
    const out: Import[] = []
    walk(tree, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const specifier = n.moduleSpecifier.text
        const names: string[] = []
        const clause = n.importClause
        if (clause?.name) names.push(clause.name.text)
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const elem of clause.namedBindings.elements) names.push(elem.name.text)
        }
        out.push({ specifier, names, location: locationOf(tree, n) })
      }
    })
    return out
  },
  findCallsTo(tree, name) {
    const out: ts.Node[] = []
    walk(tree, (n) => {
      if (ts.isCallExpression(n)) {
        const expr = n.expression
        let target = ''
        if (ts.isIdentifier(expr)) target = expr.text
        else if (ts.isPropertyAccessExpression(expr)) target = expr.name.text
        if (target === name) out.push(n)
      }
    })
    return out
  },
  findStringLiterals(tree) {
    const out: { value: string; location: Location }[] = []
    walk(tree, (n) => {
      if (ts.isStringLiteralLike(n)) {
        out.push({ value: n.text, location: locationOf(tree, n) })
      }
    })
    return out
  },
  getLocation(tree, node) {
    return locationOf(tree, node)
  },
  getText(tree, node) {
    return node.getText(tree)
  },
}
