/**
 * Exact-mode TypeScript collector for declaration + cross-file reference
 * semantic facts (P2 MCP audit Phase 3 Task 3.3).
 *
 * Walks discovered project source files after call resolve, reusing the shared
 * {@link CrossPackageContext}, program/checker, {@link unaliasSymbol}, and
 * project-relative path helpers. Emits only cross-file references
 * (`referenceScope: 'cross-file'`). Fast mode never calls this — the plane is
 * omitted entirely there.
 *
 * Pure relative to the supplied program/files: no second Program, no extra
 * filesystem walker, no node_modules declaration retention.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_SEMANTIC_FACT_LIMITS,
  applySemanticFactCaps,
  emptySemanticFactBundle,
  isTestFilePath,
  makeDeclarationId,
  makeReferenceId,
  packageGroupOf,
  resolveSpecifierToPackage,
  sortReasonCodes,
  type CrossFileReferenceFact,
  type DeclarationFact,
  type DeclarationKind,
  type SemanticConfidence,
  type SemanticExportRole,
  type SemanticFactBundle,
  type SemanticFactLimits,
  type SemanticResolutionBasis,
  type SemanticVisibility,
} from '@opensip-cli/graph';
import { isPathInside } from '@opensip-cli/core';
import ts from 'typescript';

import { unaliasSymbol } from './edge-helpers/unalias-symbol.js';

import type { CrossPackageContext } from './edge-helpers/cross-package-context.js';

/** Inputs for {@link collectSemanticReferenceFacts}. */
export interface CollectSemanticFactsInput {
  readonly program: ts.Program;
  /** Absolute realpath-normalized discovered project source files. */
  readonly discoveredFiles: readonly string[];
  readonly projectRootAbs: string;
  readonly crossPackage: CrossPackageContext;
  readonly limits?: SemanticFactLimits;
}

interface MutableCoverage {
  inspectedDeclarations: number;
  emittedDeclarations: number;
  omittedDeclarations: number;
  inspectedReferences: number;
  emittedReferences: number;
  omittedReferences: number;
  reasons: string[];
}

interface DeclRecord {
  readonly fact: DeclarationFact;
  readonly symbol: ts.Symbol;
}

/**
 * Collect bounded declaration + cross-file reference facts from an exact
 * TypeScript program. Always returns a PRESENT bundle (empty arrays + complete
 * coverage when nothing qualifies).
 */
export function collectSemanticReferenceFacts(
  input: CollectSemanticFactsInput,
): SemanticFactBundle {
  const limits = input.limits ?? DEFAULT_SEMANTIC_FACT_LIMITS;
  const coverage: MutableCoverage = {
    inspectedDeclarations: 0,
    emittedDeclarations: 0,
    omittedDeclarations: 0,
    inspectedReferences: 0,
    emittedReferences: 0,
    omittedReferences: 0,
    reasons: [],
  };

  const projectRootReal = safeRealpath(input.projectRootAbs);
  if (projectRootReal === undefined) {
    coverage.reasons.push('project-root-unresolvable');
    return emptySemanticFactBundle({
      status: 'partial',
      reasons: sortReasonCodes(coverage.reasons),
    });
  }

  const discoveredSet = new Set(input.discoveredFiles.map((f) => normalizeAbs(f)));
  const checker = input.program.getTypeChecker();

  // Phase 1: collect declarations from project source files.
  const declBySymbol = new Map<ts.Symbol, DeclRecord>();
  const decls: DeclarationFact[] = [];

  for (const sf of input.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!discoveredSet.has(normalizeAbs(sf.fileName))) continue;
    const filePath = toProjectRel(sf.fileName, projectRootReal, coverage);
    if (filePath === undefined) continue;

    const pkg = packageGroupOf(filePath, input.crossPackage.manifestIndex);
    visitDeclarations(sf, sf, checker, filePath, pkg, limits, coverage, decls, declBySymbol);
    if (decls.length >= limits.maxDeclarations) {
      coverage.reasons.push('declaration-cap');
      break;
    }
  }

  // Unique exported-declaration index for workspace .d.ts joins.
  const exportIndex = buildUniqueExportIndex(decls, input.crossPackage);

  // Phase 2: collect cross-file references.
  const refs: CrossFileReferenceFact[] = [];
  for (const sf of input.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue; // omit reference sites inside .d.ts
    if (!discoveredSet.has(normalizeAbs(sf.fileName))) continue;
    const filePath = toProjectRel(sf.fileName, projectRootReal, coverage);
    if (filePath === undefined) continue;
    const pkg = packageGroupOf(filePath, input.crossPackage.manifestIndex);
    visitReferences(
      sf,
      checker,
      filePath,
      pkg,
      projectRootReal,
      declBySymbol,
      exportIndex,
      input.crossPackage,
      limits,
      coverage,
      refs,
    );
    if (refs.length >= limits.maxReferences) {
      coverage.reasons.push('reference-cap');
      break;
    }
  }

  return applySemanticFactCaps(
    decls,
    refs,
    {
      status: coverage.reasons.length > 0 ? 'partial' : 'complete',
      inspectedDeclarations: coverage.inspectedDeclarations,
      emittedDeclarations: decls.length,
      omittedDeclarations: coverage.omittedDeclarations,
      inspectedReferences: coverage.inspectedReferences,
      emittedReferences: refs.length,
      omittedReferences: coverage.omittedReferences,
      reasons: sortReasonCodes(coverage.reasons),
    },
    limits,
  );
}

function visitDeclarations(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  pkg: string,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
  decls: DeclarationFact[],
  declBySymbol: Map<ts.Symbol, DeclRecord>,
): void {
  const kind = declarationKindOf(node);
  if (kind !== undefined) {
    coverage.inspectedDeclarations++;
    if (decls.length >= limits.maxDeclarations) {
      coverage.omittedDeclarations++;
      return;
    }
    const fact = buildDeclarationFact(node, sourceFile, checker, filePath, pkg, kind, limits, coverage);
    if (fact !== undefined) {
      decls.push(fact);
      coverage.emittedDeclarations++;
      const sym = symbolOfDeclaration(node, checker);
      if (sym !== undefined) {
        const real = unaliasSymbol(sym, checker);
        if (!declBySymbol.has(real)) declBySymbol.set(real, { fact, symbol: real });
      }
    } else {
      coverage.omittedDeclarations++;
    }
  }
  ts.forEachChild(node, (child) => {
    visitDeclarations(child, sourceFile, checker, filePath, pkg, limits, coverage, decls, declBySymbol);
  });
}

function visitReferences(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  pkg: string,
  projectRootReal: string,
  declBySymbol: ReadonlyMap<ts.Symbol, DeclRecord>,
  exportIndex: UniqueExportIndex,
  crossPackage: CrossPackageContext,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
  refs: CrossFileReferenceFact[],
): void {
  const visit = (node: ts.Node): void => {
    if (refs.length >= limits.maxReferences) return;

    // Identifier / type-reference / heritage / import-export sites.
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      maybeEmitReference(
        node,
        sourceFile,
        checker,
        filePath,
        pkg,
        projectRootReal,
        declBySymbol,
        exportIndex,
        crossPackage,
        limits,
        coverage,
        refs,
      );
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      emitImportExportReferences(
        node,
        sourceFile,
        checker,
        filePath,
        pkg,
        projectRootReal,
        declBySymbol,
        exportIndex,
        crossPackage,
        limits,
        coverage,
        refs,
      );
    } else if (
      ts.isExpressionWithTypeArguments(node) ||
      ts.isTypeReferenceNode(node) ||
      ts.isHeritageClause(node)
    ) {
      // Walk children for identifiers; kind inferred at identifier site.
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function maybeEmitReference(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  pkg: string,
  projectRootReal: string,
  declBySymbol: ReadonlyMap<ts.Symbol, DeclRecord>,
  exportIndex: UniqueExportIndex,
  crossPackage: CrossPackageContext,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
  refs: CrossFileReferenceFact[],
): void {
  const id = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)
      ? node.name
      : undefined;
  if (id === undefined) return;

  // Skip declaration names themselves (they are declarations, not references).
  if (isDeclarationName(id)) return;

  coverage.inspectedReferences++;
  if (refs.length >= limits.maxReferences) {
    coverage.omittedReferences++;
    return;
  }

  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(id);
  } catch {
    coverage.omittedReferences++;
    return;
  }
  if (symbol === undefined) {
    coverage.omittedReferences++;
    return;
  }

  const real = unaliasSymbol(symbol, checker);
  const refKind = referenceKindOf(id, sourceFile);
  const span = nodeSpan(id, sourceFile, limits, coverage);
  if (span === undefined) {
    coverage.omittedReferences++;
    return;
  }

  const local = declBySymbol.get(real);
  if (local !== undefined) {
    // Same-file references are intentionally omitted.
    if (local.fact.filePath === filePath) {
      coverage.omittedReferences++;
      return;
    }
    const fact = makeRefFact({
      kind: refKind,
      filePath,
      package: pkg,
      span,
      target: local.fact,
      basis: 'compiler-declaration',
      confidence: 'high',
      inTestFile: isTestFilePath(filePath),
      definedInGenerated: isGeneratedFile(filePath),
      limits,
      coverage,
    });
    if (fact !== undefined) {
      refs.push(fact);
      coverage.emittedReferences++;
    } else {
      coverage.omittedReferences++;
    }
    return;
  }

  // Target not in local declaration inventory — try workspace .d.ts join or external.
  const decls = real.getDeclarations() ?? [];
  const primary = decls[0];
  if (primary === undefined) {
    coverage.omittedReferences++;
    return;
  }
  const declSf = primary.getSourceFile();
  if (!declSf.isDeclarationFile) {
    // Source decl outside discovered set / path filter — unresolved.
    const fact = makeRefFact({
      kind: refKind,
      filePath,
      package: pkg,
      span,
      targetName: boundText(real.getName(), limits),
      basis: 'unresolved',
      confidence: 'low',
      reason: 'target-not-in-project-inventory',
      inTestFile: isTestFilePath(filePath),
      definedInGenerated: isGeneratedFile(filePath),
      limits,
      coverage,
    });
    if (fact !== undefined) {
      refs.push(fact);
      coverage.emittedReferences++;
    } else coverage.omittedReferences++;
    return;
  }

  // Declaration-file target: attempt workspace join via import specifier index.
  const importSpec = findImportSpecifierForName(sourceFile, id.text);
  if (importSpec !== undefined) {
    const resolved = resolveSpecifierToPackage(importSpec, crossPackage.manifestIndex);
    if (resolved !== undefined) {
      const targetName = real.getName();
      const targetKind = guessKindFromFlags(real);
      const joined = exportIndex.lookup(resolved.packageGroup, targetName, targetKind);
      if (joined === 'ambiguous') {
        const fact = makeRefFact({
          kind: refKind,
          filePath,
          package: pkg,
          span,
          targetName: boundText(targetName, limits),
          targetPackage: resolved.packageGroup,
          targetKind,
          basis: 'ambiguous',
          confidence: 'low',
          reason: 'cross-package-join-ambiguous',
          importSpecifier: boundText(importSpec, limits),
          inTestFile: isTestFilePath(filePath),
          definedInGenerated: isGeneratedFile(filePath),
          limits,
          coverage,
        });
        if (fact !== undefined) {
          refs.push(fact);
          coverage.emittedReferences++;
        } else coverage.omittedReferences++;
        coverage.reasons.push('cross-package-join-ambiguous');
        return;
      }
      if (joined !== undefined) {
        const fact = makeRefFact({
          kind: refKind,
          filePath,
          package: pkg,
          span,
          target: joined,
          basis: 'workspace-export-index',
          confidence: 'high',
          importSpecifier: boundText(importSpec, limits),
          inTestFile: isTestFilePath(filePath),
          definedInGenerated: isGeneratedFile(filePath),
          limits,
          coverage,
        });
        if (fact !== undefined) {
          refs.push(fact);
          coverage.emittedReferences++;
        } else coverage.omittedReferences++;
        return;
      }
      // Workspace package but no unique export match — keep unresolved descriptor.
      const fact = makeRefFact({
        kind: refKind,
        filePath,
        package: pkg,
        span,
        targetName: boundText(targetName, limits),
        targetPackage: resolved.packageGroup,
        targetKind,
        basis: 'unresolved',
        confidence: 'low',
        reason: 'cross-package-join-not-found',
        importSpecifier: boundText(importSpec, limits),
        inTestFile: isTestFilePath(filePath),
        definedInGenerated: isGeneratedFile(filePath),
        limits,
        coverage,
      });
      if (fact !== undefined) {
        refs.push(fact);
        coverage.emittedReferences++;
      } else coverage.omittedReferences++;
      return;
    }
  }

  // External / lib .d.ts — label external, no target id.
  if (isExternalDeclarationFile(declSf.fileName, projectRootReal)) {
    const fact = makeRefFact({
      kind: refKind,
      filePath,
      package: pkg,
      span,
      targetName: boundText(real.getName(), limits),
      basis: 'external',
      confidence: 'low',
      reason: 'external-declaration',
      importSpecifier: importSpec === undefined ? undefined : boundText(importSpec, limits),
      inTestFile: isTestFilePath(filePath),
      definedInGenerated: isGeneratedFile(filePath),
      limits,
      coverage,
    });
    if (fact !== undefined) {
      refs.push(fact);
      coverage.emittedReferences++;
    } else coverage.omittedReferences++;
    return;
  }

  coverage.omittedReferences++;
}

function emitImportExportReferences(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  pkg: string,
  projectRootReal: string,
  declBySymbol: ReadonlyMap<ts.Symbol, DeclRecord>,
  exportIndex: UniqueExportIndex,
  crossPackage: CrossPackageContext,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
  refs: CrossFileReferenceFact[],
): void {
  const moduleSpec = node.moduleSpecifier;
  if (moduleSpec === undefined || !ts.isStringLiteral(moduleSpec)) return;
  const specifier = moduleSpec.text;

  const named =
    ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined
      ? node.importClause.namedBindings
      : ts.isExportDeclaration(node) && node.exportClause !== undefined
        ? node.exportClause
        : undefined;

  if (named !== undefined && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      maybeEmitReference(
        el.name,
        sourceFile,
        checker,
        filePath,
        pkg,
        projectRootReal,
        declBySymbol,
        exportIndex,
        crossPackage,
        limits,
        coverage,
        refs,
      );
    }
  } else if (named !== undefined && ts.isNamedExports(named)) {
    for (const el of named.elements) {
      maybeEmitReference(
        el.name,
        sourceFile,
        checker,
        filePath,
        pkg,
        projectRootReal,
        declBySymbol,
        exportIndex,
        crossPackage,
        limits,
        coverage,
        refs,
      );
    }
  } else {
    // Side-effect import / star re-export: record the module reference site.
    coverage.inspectedReferences++;
    const span = nodeSpan(moduleSpec, sourceFile, limits, coverage);
    if (span === undefined) {
      coverage.omittedReferences++;
      return;
    }
    const kind: CrossFileReferenceFact['kind'] = ts.isImportDeclaration(node)
      ? 'import'
      : 'export';
    const resolved = resolveSpecifierToPackage(specifier, crossPackage.manifestIndex);
    const fact = makeRefFact({
      kind,
      filePath,
      package: pkg,
      span,
      targetPackage: resolved?.packageGroup,
      basis: resolved !== undefined ? 'import-specifier' : specifier.startsWith('.') ? 'unresolved' : 'external',
      confidence: resolved !== undefined ? 'medium' : 'low',
      reason: resolved === undefined ? (specifier.startsWith('.') ? 'relative-module-ref' : 'external-module') : undefined,
      importSpecifier: boundText(specifier, limits),
      inTestFile: isTestFilePath(filePath),
      definedInGenerated: isGeneratedFile(filePath),
      limits,
      coverage,
    });
    if (fact !== undefined) {
      refs.push(fact);
      coverage.emittedReferences++;
    } else coverage.omittedReferences++;
  }
}

function buildDeclarationFact(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  pkg: string,
  kind: DeclarationKind,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
): DeclarationFact | undefined {
  const nameNode = declarationNameNode(node);
  const name = nameNode?.getText(sourceFile) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
  if (name === undefined || name.length === 0) return undefined;
  if (!isSafeSemanticText(name, limits.maxName)) {
    coverage.reasons.push('hostile-declaration-name');
    return undefined;
  }
  const span = nodeSpan(nameNode ?? node, sourceFile, limits, coverage);
  if (span === undefined) return undefined;

  const visibility = visibilityOf(node, sourceFile);
  const exportRole = exportRoleOf(node, sourceFile);
  const qualifiedName = boundText(
    `${filePath.replace(/\.[^.]+$/, '')}.${name}`,
    limits,
  );
  if (qualifiedName === undefined) {
    coverage.reasons.push('hostile-qualified-name');
    return undefined;
  }

  const declarationId = makeDeclarationId({
    package: pkg,
    filePath,
    kind,
    name,
    line: span.line,
    column: span.column,
  });

  return {
    declarationId,
    name,
    qualifiedName,
    kind,
    package: pkg,
    filePath,
    line: span.line,
    column: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
    visibility,
    exportRole,
    inTestFile: isTestFilePath(filePath),
    definedInGenerated: isGeneratedFile(filePath),
  };
}

function makeRefFact(input: {
  readonly kind: CrossFileReferenceFact['kind'];
  readonly filePath: string;
  readonly package: string;
  readonly span: Span;
  readonly target?: DeclarationFact;
  readonly targetName?: string;
  readonly targetPackage?: string;
  readonly targetKind?: DeclarationKind;
  readonly basis: SemanticResolutionBasis;
  readonly confidence: SemanticConfidence;
  readonly reason?: string;
  readonly importSpecifier?: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly limits: SemanticFactLimits;
  readonly coverage: MutableCoverage;
}): CrossFileReferenceFact | undefined {
  const targetName = input.target?.name ?? input.targetName;
  const targetPackage = input.target?.package ?? input.targetPackage;
  const targetKind = input.target?.kind ?? input.targetKind;
  if (targetName !== undefined && !isSafeSemanticText(targetName, input.limits.maxName)) {
    input.coverage.reasons.push('hostile-reference-target-name');
    return undefined;
  }
  if (
    input.importSpecifier !== undefined &&
    !isSafeSemanticText(input.importSpecifier, input.limits.maxText)
  ) {
    input.coverage.reasons.push('hostile-import-specifier');
    return undefined;
  }
  const referenceId = makeReferenceId({
    filePath: input.filePath,
    kind: input.kind,
    line: input.span.line,
    column: input.span.column,
    targetDeclarationId: input.target?.declarationId,
    targetPackage,
    targetName,
  });
  return {
    referenceId,
    kind: input.kind,
    filePath: input.filePath,
    line: input.span.line,
    column: input.span.column,
    endLine: input.span.endLine,
    endColumn: input.span.endColumn,
    package: input.package,
    ...(input.target !== undefined
      ? { targetDeclarationId: input.target.declarationId }
      : {}),
    ...(targetPackage === undefined ? {} : { targetPackage }),
    ...(targetName === undefined ? {} : { targetName }),
    ...(targetKind === undefined ? {} : { targetKind }),
    basis: input.basis,
    confidence: input.confidence,
    ...(input.importSpecifier === undefined ? {} : { importSpecifier: input.importSpecifier }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    inTestFile: input.inTestFile,
    definedInGenerated: input.definedInGenerated,
  };
}

// ── kind / visibility helpers ──────────────────────────────────────

function declarationKindOf(node: ts.Node): DeclarationKind | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return 'function';
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type-alias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return 'method';
  }
  if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
    return 'import';
  }
  if (ts.isExportSpecifier(node)) return 'export';
  return undefined;
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name;
  }
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return node.name;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name;
  }
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) return node.name;
  if (ts.isNamespaceImport(node)) return node.name;
  return undefined;
}

function symbolOfDeclaration(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(declarationNameNode(node) ?? node);
  } catch {
    return undefined;
  }
}

function visibilityOf(node: ts.Node, _sourceFile: ts.SourceFile): SemanticVisibility {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (
    mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    hasExportModifierInParent(node)
  ) {
    return 'exported';
  }
  return 'module-local';
}

function exportRoleOf(node: ts.Node, _sourceFile: ts.SourceFile): SemanticExportRole {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return 'default-export';
  if (
    mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    hasExportModifierInParent(node)
  ) {
    return 'named-export';
  }
  if (ts.isExportSpecifier(node)) return 're-export';
  return 'none';
}

function hasExportModifierInParent(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableStatement(parent)) {
    const mods = ts.getModifiers(parent);
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
  }
  return false;
}

function referenceKindOf(id: ts.Identifier, _sourceFile: ts.SourceFile): CrossFileReferenceFact['kind'] {
  let cur: ts.Node | undefined = id.parent;
  while (cur !== undefined) {
    if (ts.isTypeReferenceNode(cur) || ts.isTypeQueryNode(cur)) return 'type';
    if (ts.isExpressionWithTypeArguments(cur) && cur.parent && ts.isHeritageClause(cur.parent)) {
      return 'heritage';
    }
    if (ts.isHeritageClause(cur)) return 'heritage';
    if (
      ts.isTypeNode(cur) ||
      ts.isTypeParameterDeclaration(cur) ||
      (ts.isAsExpression(cur) && cur.type !== undefined)
    ) {
      return 'annotation';
    }
    if (ts.isImportSpecifier(cur) || ts.isImportClause(cur) || ts.isNamespaceImport(cur)) {
      return 'import';
    }
    if (ts.isExportSpecifier(cur)) return 'export';
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur) || ts.isPropertyAccessExpression(cur)) {
      return 'value';
    }
    cur = cur.parent;
  }
  return 'value';
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isVariableDeclaration(p)) &&
    p.name === id
  ) {
    return true;
  }
  return false;
}

function guessKindFromFlags(symbol: ts.Symbol): DeclarationKind {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Interface) return 'interface';
  if (f & ts.SymbolFlags.TypeAlias) return 'type-alias';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Method) return 'method';
  if (f & ts.SymbolFlags.Property || f & ts.SymbolFlags.Accessor) return 'property';
  if (f & ts.SymbolFlags.Namespace) return 'namespace';
  if (f & ts.SymbolFlags.Variable || f & ts.SymbolFlags.BlockScopedVariable) return 'variable';
  return 'variable';
}

// ── path / span / text bounds ──────────────────────────────────────

interface Span {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

function nodeSpan(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  limits: SemanticFactLimits,
  coverage: MutableCoverage,
): Span | undefined {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const line = start.line + 1;
  const column = start.character;
  const endLine = end.line + 1;
  const endColumn = end.character;
  if (
    line < 1 ||
    line > limits.maxLine ||
    endLine < 1 ||
    endLine > limits.maxLine ||
    column < 0 ||
    column > limits.maxColumn ||
    endColumn < 0 ||
    endColumn > limits.maxColumn
  ) {
    coverage.reasons.push('span-out-of-bounds');
    return undefined;
  }
  return { line, column, endLine, endColumn };
}

function toProjectRel(
  absPath: string,
  projectRootReal: string,
  coverage: MutableCoverage,
): string | undefined {
  const real = safeRealpath(absPath);
  if (real === undefined) {
    coverage.reasons.push('source-realpath-unresolvable');
    return undefined;
  }
  if (!isPathInside(real, projectRootReal)) {
    coverage.reasons.push('path-outside-root');
    return undefined;
  }
  const rel = relative(projectRootReal, real).split(sep).join('/');
  if (!isSafeProjectRelPath(rel)) {
    coverage.reasons.push('hostile-project-path');
    return undefined;
  }
  return rel;
}

function isSafeProjectRelPath(path: string): boolean {
  if (path.length === 0 || path.length > DEFAULT_SEMANTIC_FACT_LIMITS.maxText) return false;
  if (isAbsolute(path) || path.includes('\0') || /\\/.test(path)) return false;
  if (/^[A-Za-z]:/.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return false;
  if (/\p{Cc}/u.test(path)) return false;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function isSafeSemanticText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value) && !value.includes('\0');
}

function boundText(value: string, limits: SemanticFactLimits): string | undefined {
  if (value.length === 0 || /\p{Cc}/u.test(value) || value.includes('\0')) return undefined;
  if (value.length > limits.maxText) return undefined;
  return value;
}

function normalizeAbs(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function isGeneratedFile(rel: string): boolean {
  return /\bdist\/|\bbuild\/|\.generated\./.test(rel);
}

function isExternalDeclarationFile(fileName: string, projectRootReal: string): boolean {
  const real = safeRealpath(fileName);
  if (real === undefined) return true;
  if (!isPathInside(real, projectRootReal)) return true;
  const norm = real.split(sep).join('/');
  return (
    norm.includes('/node_modules/') ||
    norm.includes('/typescript/lib/') ||
    /\/lib\.[^/]+\.d\.ts$/.test(norm)
  );
}

function findImportSpecifierForName(sourceFile: ts.SourceFile, localName: string): string | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    if (clause.name?.text === localName) return stmt.moduleSpecifier.text;
    if (clause.namedBindings !== undefined) {
      if (ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === localName) {
        return stmt.moduleSpecifier.text;
      }
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.name.text === localName) return stmt.moduleSpecifier.text;
        }
      }
    }
  }
  return undefined;
}

// ── unique export index ────────────────────────────────────────────

interface UniqueExportIndex {
  lookup(
    packageGroup: string,
    name: string,
    kind: DeclarationKind,
  ): DeclarationFact | 'ambiguous' | undefined;
}

function buildUniqueExportIndex(
  decls: readonly DeclarationFact[],
  crossPackage: CrossPackageContext,
): UniqueExportIndex {
  const unique = new Map<string, DeclarationFact>();
  const ambiguous = new Set<string>();
  for (const d of decls) {
    if (
      d.exportRole !== 'named-export' &&
      d.exportRole !== 'default-export' &&
      d.exportRole !== 're-export'
    ) {
      continue;
    }
    const pkg = packageGroupOf(d.filePath, crossPackage.manifestIndex);
    const key = `${pkg}\0${d.name}\0${d.kind}`;
    if (ambiguous.has(key)) continue;
    const existing = unique.get(key);
    if (existing === undefined) unique.set(key, d);
    else if (existing.declarationId !== d.declarationId) {
      unique.delete(key);
      ambiguous.add(key);
    }
  }
  return {
    lookup(packageGroup, name, kind) {
      const key = `${packageGroup}\0${name}\0${kind}`;
      if (ambiguous.has(key)) return 'ambiguous';
      return unique.get(key);
    },
  };
}
