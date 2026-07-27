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

import { isPathInside } from '@opensip-cli/core';
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
  throwIfGraphAdapterAborted,
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
  readonly signal?: AbortSignal;
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

/** Shared program-scope inputs for both declaration and reference collection. */
interface CollectScope {
  readonly program: ts.Program;
  readonly discoveredSet: ReadonlySet<string>;
  readonly checker: ts.TypeChecker;
  readonly projectRootReal: string;
  readonly crossPackage: CrossPackageContext;
  readonly limits: SemanticFactLimits;
  readonly coverage: MutableCoverage;
  readonly signal?: AbortSignal;
}

/** Mutable sinks + shared scope for phase-1 declaration collection. */
interface DeclarationCollectCtx extends CollectScope {
  readonly decls: DeclarationFact[];
  readonly declBySymbol: Map<ts.Symbol, DeclRecord>;
}

/** Mutable sinks + shared scope for phase-2 reference collection. */
interface ReferenceCollectCtx extends CollectScope {
  readonly declBySymbol: ReadonlyMap<ts.Symbol, DeclRecord>;
  readonly exportIndex: UniqueExportIndex;
  readonly refs: CrossFileReferenceFact[];
}

/** Per-source-file declaration walk context (wide params collapsed). */
interface FileDeclarationCtx {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly filePath: string;
  readonly pkg: string;
  readonly limits: SemanticFactLimits;
  readonly coverage: MutableCoverage;
  readonly decls: DeclarationFact[];
  readonly declBySymbol: Map<ts.Symbol, DeclRecord>;
}

/** Per-source-file reference walk context (wide params collapsed). */
interface FileReferenceCtx {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly filePath: string;
  readonly pkg: string;
  readonly projectRootReal: string;
  readonly declBySymbol: ReadonlyMap<ts.Symbol, DeclRecord>;
  readonly exportIndex: UniqueExportIndex;
  readonly crossPackage: CrossPackageContext;
  readonly limits: SemanticFactLimits;
  readonly coverage: MutableCoverage;
  readonly refs: CrossFileReferenceFact[];
}

/**
 * Collect bounded declaration + cross-file reference facts from an exact
 * TypeScript program. Always returns a PRESENT bundle (empty arrays + complete
 * coverage when nothing qualifies).
 */
export function collectSemanticReferenceFacts(
  input: CollectSemanticFactsInput,
): SemanticFactBundle {
  throwIfGraphAdapterAborted(input.signal, 'TypeScript semantic fact collection');
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
  const scope: CollectScope = {
    program: input.program,
    discoveredSet,
    checker,
    projectRootReal,
    crossPackage: input.crossPackage,
    limits,
    coverage,
    signal: input.signal,
  };

  // Phase 1: collect declarations from project source files.
  const declBySymbol = new Map<ts.Symbol, DeclRecord>();
  const decls: DeclarationFact[] = [];
  collectDeclarations({ ...scope, decls, declBySymbol });
  throwIfGraphAdapterAborted(input.signal, 'TypeScript semantic declaration collection');

  // Unique exported-declaration index for workspace .d.ts joins.
  const exportIndex = buildUniqueExportIndex(decls, input.crossPackage);

  // Phase 2: collect cross-file references.
  const refs: CrossFileReferenceFact[] = [];
  collectReferences({ ...scope, declBySymbol, exportIndex, refs });
  throwIfGraphAdapterAborted(input.signal, 'TypeScript semantic reference collection');

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

/** Phase 1: collect declaration facts from discovered project source files. */
function collectDeclarations(ctx: DeclarationCollectCtx): void {
  for (const sf of ctx.program.getSourceFiles()) {
    throwIfGraphAdapterAborted(ctx.signal, 'TypeScript semantic declaration collection');
    if (sf.isDeclarationFile) continue;
    if (!ctx.discoveredSet.has(normalizeAbs(sf.fileName))) continue;
    const filePath = toProjectRel(sf.fileName, ctx.projectRootReal, ctx.coverage);
    if (filePath === undefined) continue;
    const pkg = packageGroupOf(filePath, ctx.crossPackage.manifestIndex);
    const fileCtx: FileDeclarationCtx = {
      sourceFile: sf,
      checker: ctx.checker,
      filePath,
      pkg,
      limits: ctx.limits,
      coverage: ctx.coverage,
      decls: ctx.decls,
      declBySymbol: ctx.declBySymbol,
    };
    visitDeclarations(sf, fileCtx);
    if (ctx.decls.length >= ctx.limits.maxDeclarations) {
      ctx.coverage.reasons.push('declaration-cap');
      break;
    }
  }
}

/** Phase 2: collect cross-file reference facts from discovered project source files. */
function collectReferences(ctx: ReferenceCollectCtx): void {
  for (const sf of ctx.program.getSourceFiles()) {
    throwIfGraphAdapterAborted(ctx.signal, 'TypeScript semantic reference collection');
    if (sf.isDeclarationFile) continue; // omit reference sites inside .d.ts
    if (!ctx.discoveredSet.has(normalizeAbs(sf.fileName))) continue;
    const filePath = toProjectRel(sf.fileName, ctx.projectRootReal, ctx.coverage);
    if (filePath === undefined) continue;
    const pkg = packageGroupOf(filePath, ctx.crossPackage.manifestIndex);
    visitReferences({
      sourceFile: sf,
      checker: ctx.checker,
      filePath,
      pkg,
      projectRootReal: ctx.projectRootReal,
      declBySymbol: ctx.declBySymbol,
      exportIndex: ctx.exportIndex,
      crossPackage: ctx.crossPackage,
      limits: ctx.limits,
      coverage: ctx.coverage,
      refs: ctx.refs,
    });
    if (ctx.refs.length >= ctx.limits.maxReferences) {
      ctx.coverage.reasons.push('reference-cap');
      break;
    }
  }
}

function visitDeclarations(node: ts.Node, ctx: FileDeclarationCtx): void {
  const kind = declarationKindOf(node);
  if (kind !== undefined) {
    ctx.coverage.inspectedDeclarations++;
    if (ctx.decls.length >= ctx.limits.maxDeclarations) {
      ctx.coverage.omittedDeclarations++;
      return;
    }
    const fact = buildDeclarationFact(node, kind, ctx);
    if (fact === undefined) {
      ctx.coverage.omittedDeclarations++;
    } else {
      ctx.decls.push(fact);
      ctx.coverage.emittedDeclarations++;
      const sym = symbolOfDeclaration(node, ctx.checker);
      if (sym !== undefined) {
        const real = unaliasSymbol(sym, ctx.checker);
        if (!ctx.declBySymbol.has(real)) ctx.declBySymbol.set(real, { fact, symbol: real });
      }
    }
  }
  ts.forEachChild(node, (child) => {
    visitDeclarations(child, ctx);
  });
}

function visitReferences(ctx: FileReferenceCtx): void {
  const visit = (node: ts.Node): void => {
    if (ctx.refs.length >= ctx.limits.maxReferences) return;

    // Identifier / type-reference / heritage / import-export sites.
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      maybeEmitReference(node, ctx);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      emitImportExportReferences(node, ctx);
    } else if (
      ts.isExpressionWithTypeArguments(node) ||
      ts.isTypeReferenceNode(node) ||
      ts.isHeritageClause(node)
    ) {
      // Walk children for identifiers; kind inferred at identifier site.
    }

    ts.forEachChild(node, visit);
  };
  visit(ctx.sourceFile);
}

/** Resolve the identifier a reference site keys on (identifier or member name). */
function referenceIdentifier(node: ts.Node): ts.Identifier | undefined {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name;
  return undefined;
}

/** Push an emitted fact or record an omission (shared by every reference branch). */
function pushOrOmit(
  fact: CrossFileReferenceFact | undefined,
  refs: CrossFileReferenceFact[],
  coverage: MutableCoverage,
): void {
  if (fact === undefined) {
    coverage.omittedReferences++;
  } else {
    refs.push(fact);
    coverage.emittedReferences++;
  }
}

/** Invariant per-reference-site emit context shared across resolution branches. */
interface ReferenceEmitContext {
  readonly refKind: CrossFileReferenceFact['kind'];
  readonly filePath: string;
  readonly pkg: string;
  readonly span: Span;
  readonly sourceFile: ts.SourceFile;
  readonly projectRootReal: string;
  readonly exportIndex: UniqueExportIndex;
  readonly crossPackage: CrossPackageContext;
  readonly limits: SemanticFactLimits;
  readonly coverage: MutableCoverage;
  readonly refs: CrossFileReferenceFact[];
}

/** Per-branch target/basis fields layered onto the invariant emit context. */
interface RefFactFields {
  readonly target?: DeclarationFact;
  readonly targetName?: string;
  readonly targetPackage?: string;
  readonly targetKind?: DeclarationKind;
  readonly basis: SemanticResolutionBasis;
  readonly confidence: SemanticConfidence;
  readonly reason?: string;
  readonly importSpecifier?: string;
}

/** Build a reference fact from context + branch fields, then push or omit it. */
function emitRefFact(ctx: ReferenceEmitContext, fields: RefFactFields): void {
  const fact = makeRefFact({
    kind: ctx.refKind,
    filePath: ctx.filePath,
    package: ctx.pkg,
    span: ctx.span,
    ...fields,
    inTestFile: isTestFilePath(ctx.filePath),
    definedInGenerated: isGeneratedFile(ctx.filePath),
    limits: ctx.limits,
    coverage: ctx.coverage,
  });
  pushOrOmit(fact, ctx.refs, ctx.coverage);
}

function maybeEmitReference(node: ts.Node, file: FileReferenceCtx): void {
  const id = referenceIdentifier(node);
  if (id === undefined) return;

  // Skip declaration names themselves (they are declarations, not references).
  if (isDeclarationName(id)) return;

  file.coverage.inspectedReferences++;
  if (file.refs.length >= file.limits.maxReferences) {
    file.coverage.omittedReferences++;
    return;
  }

  let symbol: ts.Symbol | undefined;
  try {
    symbol = file.checker.getSymbolAtLocation(id);
  } catch {
    // @swallow-ok the TypeScript checker throws on some synthetic nodes; no symbol means no semantic fact, and the occurrence is still recorded from syntax
    symbol = undefined;
  }
  if (symbol === undefined) {
    file.coverage.omittedReferences++;
    return;
  }

  const real = unaliasSymbol(symbol, file.checker);
  const span = nodeSpan(id, file.sourceFile, file.limits, file.coverage);
  if (span === undefined) {
    file.coverage.omittedReferences++;
    return;
  }

  const ctx: ReferenceEmitContext = {
    refKind: referenceKindOf(id, file.sourceFile),
    filePath: file.filePath,
    pkg: file.pkg,
    span,
    sourceFile: file.sourceFile,
    projectRootReal: file.projectRootReal,
    exportIndex: file.exportIndex,
    crossPackage: file.crossPackage,
    limits: file.limits,
    coverage: file.coverage,
    refs: file.refs,
  };

  const local = file.declBySymbol.get(real);
  if (local !== undefined) {
    emitLocalReference(ctx, local);
    return;
  }

  emitNonLocalReference(ctx, real, id);
}

/** Reference to a declaration in the local inventory (same-file sites omitted). */
function emitLocalReference(ctx: ReferenceEmitContext, local: DeclRecord): void {
  // Same-file references are intentionally omitted.
  if (local.fact.filePath === ctx.filePath) {
    ctx.coverage.omittedReferences++;
    return;
  }
  emitRefFact(ctx, { target: local.fact, basis: 'compiler-declaration', confidence: 'high' });
}

/**
 * Reference whose target is not in the local inventory: unresolved source decl,
 * workspace .d.ts join, or external/lib declaration.
 */
function emitNonLocalReference(
  ctx: ReferenceEmitContext,
  real: ts.Symbol,
  id: ts.Identifier,
): void {
  const decls = real.getDeclarations() ?? [];
  const primary = decls[0];
  if (primary === undefined) {
    ctx.coverage.omittedReferences++;
    return;
  }
  const declSf = primary.getSourceFile();
  if (!declSf.isDeclarationFile) {
    if (declSf === ctx.sourceFile) {
      ctx.coverage.omittedReferences++;
      return;
    }
    // Source decl outside discovered set / path filter — unresolved.
    emitRefFact(ctx, {
      targetName: boundText(real.getName(), ctx.limits),
      basis: 'unresolved',
      confidence: 'low',
      reason: 'target-not-in-project-inventory',
    });
    return;
  }

  // Declaration-file target: attempt workspace join via import specifier index.
  const importSpec = findImportSpecifierForName(ctx.sourceFile, id.text);
  if (importSpec !== undefined && emitWorkspaceJoinReference(ctx, real, importSpec)) {
    return;
  }

  // External / lib .d.ts — label external, no target id.
  if (isExternalDeclarationFile(declSf.fileName, ctx.projectRootReal)) {
    emitRefFact(ctx, {
      targetName: boundText(real.getName(), ctx.limits),
      basis: 'external',
      confidence: 'low',
      reason: 'external-declaration',
      importSpecifier: importSpec === undefined ? undefined : boundText(importSpec, ctx.limits),
    });
    return;
  }

  ctx.coverage.omittedReferences++;
}

/**
 * Attempt a workspace .d.ts → source join via the unique export index. Returns
 * true when the reference was emitted (resolvable specifier); false when the
 * specifier does not resolve to a workspace package (caller falls through).
 */
function emitWorkspaceJoinReference(
  ctx: ReferenceEmitContext,
  real: ts.Symbol,
  importSpec: string,
): boolean {
  const resolved = resolveSpecifierToPackage(importSpec, ctx.crossPackage.manifestIndex);
  if (resolved === undefined) return false;

  const targetName = real.getName();
  const targetKind = guessKindFromFlags(real);
  if (ctx.exportIndex.isAmbiguous(resolved.packageGroup, targetName, targetKind)) {
    emitRefFact(ctx, {
      targetName: boundText(targetName, ctx.limits),
      targetPackage: resolved.packageGroup,
      targetKind,
      basis: 'ambiguous',
      confidence: 'low',
      reason: 'cross-package-join-ambiguous',
      importSpecifier: boundText(importSpec, ctx.limits),
    });
    ctx.coverage.reasons.push('cross-package-join-ambiguous');
    return true;
  }
  const joined = ctx.exportIndex.find(resolved.packageGroup, targetName, targetKind);
  if (joined !== undefined) {
    emitRefFact(ctx, {
      target: joined,
      basis: 'workspace-export-index',
      confidence: 'high',
      importSpecifier: boundText(importSpec, ctx.limits),
    });
    return true;
  }
  // Workspace package but no unique export match — keep unresolved descriptor.
  emitRefFact(ctx, {
    targetName: boundText(targetName, ctx.limits),
    targetPackage: resolved.packageGroup,
    targetKind,
    basis: 'unresolved',
    confidence: 'low',
    reason: 'cross-package-join-not-found',
    importSpecifier: boundText(importSpec, ctx.limits),
  });
  return true;
}

function emitImportExportReferences(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  file: FileReferenceCtx,
): void {
  const moduleSpec = node.moduleSpecifier;
  if (moduleSpec === undefined || !ts.isStringLiteral(moduleSpec)) return;
  const specifier = moduleSpec.text;

  const named = namedBindingsOf(node);
  if (named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
    for (const el of named.elements) {
      maybeEmitReference(el.name, file);
    }
    return;
  }

  // Side-effect import / star re-export: record the module reference site.
  emitModuleReference(node, moduleSpec, specifier, file);
}

/** Named import/export bindings for a module declaration, if present. */
function namedBindingsOf(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): ts.NamedImportBindings | ts.NamedExportBindings | undefined {
  if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
    return node.importClause.namedBindings;
  }
  if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
    return node.exportClause;
  }
  return undefined;
}

/** Classify a bare module specifier into its resolution basis + optional reason. */
function classifyModuleSpecifier(
  resolvedToPackage: boolean,
  relative: boolean,
): { readonly basis: SemanticResolutionBasis; readonly reason?: string } {
  if (resolvedToPackage) return { basis: 'import-specifier' };
  if (relative) return { basis: 'unresolved', reason: 'relative-module-ref' };
  return { basis: 'external', reason: 'external-module' };
}

/** Record the module reference site for a side-effect import / star re-export. */
function emitModuleReference(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  moduleSpec: ts.StringLiteral,
  specifier: string,
  file: FileReferenceCtx,
): void {
  file.coverage.inspectedReferences++;
  const span = nodeSpan(moduleSpec, file.sourceFile, file.limits, file.coverage);
  if (span === undefined) {
    file.coverage.omittedReferences++;
    return;
  }
  const kind: CrossFileReferenceFact['kind'] = ts.isImportDeclaration(node) ? 'import' : 'export';
  const resolved = resolveSpecifierToPackage(specifier, file.crossPackage.manifestIndex);
  const { basis, reason } = classifyModuleSpecifier(
    resolved !== undefined,
    specifier.startsWith('.'),
  );
  const fact = makeRefFact({
    kind,
    filePath: file.filePath,
    package: file.pkg,
    span,
    targetPackage: resolved?.packageGroup,
    basis,
    confidence: resolved === undefined ? 'low' : 'medium',
    reason,
    importSpecifier: boundText(specifier, file.limits),
    inTestFile: isTestFilePath(file.filePath),
    definedInGenerated: isGeneratedFile(file.filePath),
    limits: file.limits,
    coverage: file.coverage,
  });
  pushOrOmit(fact, file.refs, file.coverage);
}

function buildDeclarationFact(
  node: ts.Node,
  kind: DeclarationKind,
  ctx: FileDeclarationCtx,
): DeclarationFact | undefined {
  const nameNode = declarationNameNode(node);
  const name =
    nameNode?.getText(ctx.sourceFile) ??
    (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
  if (name === undefined || name.length === 0) return undefined;
  if (!isSafeSemanticText(name, ctx.limits.maxName)) {
    ctx.coverage.reasons.push('hostile-declaration-name');
    return undefined;
  }
  const span = nodeSpan(nameNode ?? node, ctx.sourceFile, ctx.limits, ctx.coverage);
  if (span === undefined) return undefined;

  const visibility = visibilityOf(node, ctx.sourceFile);
  const exportRole = exportRoleOf(node, ctx.sourceFile);
  const qualifiedName = boundText(`${ctx.filePath.replace(/\.[^.]+$/, '')}.${name}`, ctx.limits);
  if (qualifiedName === undefined) {
    ctx.coverage.reasons.push('hostile-qualified-name');
    return undefined;
  }

  const declarationId = makeDeclarationId({
    package: ctx.pkg,
    filePath: ctx.filePath,
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
    package: ctx.pkg,
    filePath: ctx.filePath,
    line: span.line,
    column: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
    visibility,
    exportRole,
    inTestFile: isTestFilePath(ctx.filePath),
    definedInGenerated: isGeneratedFile(ctx.filePath),
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
    ...(input.target === undefined ? {} : { targetDeclarationId: input.target.declarationId }),
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
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name;
  }
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  ) {
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
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(declarationNameNode(node) ?? node);
  } catch {
    // @swallow-ok same checker hazard on the declaration path; absence of a symbol is a valid answer here, not a failure
    symbol = undefined;
  }
  return symbol;
}

function visibilityOf(node: ts.Node, sourceFile: ts.SourceFile): SemanticVisibility {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const name = (node as ts.NamedDeclaration).name;
  if (
    mods?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ||
    (name !== undefined && ts.isPrivateIdentifier(name))
  ) {
    return 'private';
  }
  return exportRoleOf(node, sourceFile) === 'none' ? 'module-local' : 'exported';
}

function exportRoleOf(node: ts.Node, sourceFile: ts.SourceFile): SemanticExportRole {
  if (ts.isExportSpecifier(node)) return 're-export';
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return 'default-export';
  if (
    mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    hasExportModifierInParent(node)
  ) {
    return 'named-export';
  }
  const bindingName = topLevelDeclarationName(node);
  if (bindingName !== undefined) {
    const listedRole = exportListRole(bindingName, sourceFile);
    if (listedRole !== undefined) return listedRole;
  }
  return 'none';
}

function hasExportModifierInParent(node: ts.Node): boolean {
  const statement = owningVariableStatement(node);
  if (statement !== undefined) {
    const mods = ts.getModifiers(statement);
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
  }
  return false;
}

function owningVariableStatement(node: ts.Node): ts.VariableStatement | undefined {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isVariableStatement(parent)) return parent;
    if (!ts.isVariableDeclarationList(parent)) return undefined;
    parent = parent.parent;
  }
  return undefined;
}

function topLevelDeclarationName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    ts.isSourceFile(node.parent)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const statement = owningVariableStatement(node);
    if (statement !== undefined && ts.isSourceFile(statement.parent)) return node.name.text;
  }
  return undefined;
}

function exportListRole(
  bindingName: string,
  sourceFile: ts.SourceFile,
): 'named-export' | 'default-export' | undefined {
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const exported = statement.exportClause.elements.find(
        (element) => (element.propertyName ?? element.name).text === bindingName,
      );
      if (exported !== undefined) {
        return exported.name.text === 'default' ? 'default-export' : 'named-export';
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === bindingName
    ) {
      return 'default-export';
    }
  }
  return undefined;
}

function referenceKindOf(
  id: ts.Identifier,
  _sourceFile: ts.SourceFile,
): CrossFileReferenceFact['kind'] {
  let cur: ts.Node | undefined = id.parent;
  while (cur !== undefined) {
    const kind = referenceKindOfNode(cur);
    if (kind !== undefined) return kind;
    cur = cur.parent;
  }
  return 'value';
}

/** Classify a single ancestor node into a reference kind, or undefined to ascend. */
function referenceKindOfNode(cur: ts.Node): CrossFileReferenceFact['kind'] | undefined {
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
  return undefined;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p)) &&
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
  if (isAbsolute(path) || path.includes('\0') || path.includes('\\')) return false;
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

function findImportSpecifierForName(
  sourceFile: ts.SourceFile,
  localName: string,
): string | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    if (importClauseBindsName(clause, localName)) return stmt.moduleSpecifier.text;
  }
  return undefined;
}

/** Does an import clause bind `localName` (default, namespace, or named import)? */
function importClauseBindsName(clause: ts.ImportClause, localName: string): boolean {
  if (clause.name?.text === localName) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings) && bindings.name.text === localName) return true;
  if (ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (el.name.text === localName) return true;
    }
  }
  return false;
}

// ── unique export index ────────────────────────────────────────────

interface UniqueExportIndex {
  /** True when `<packageGroup, name, kind>` matched multiple distinct exports. */
  isAmbiguous(packageGroup: string, name: string, kind: DeclarationKind): boolean;
  /** The unique export for `<packageGroup, name, kind>`, or undefined if none. */
  find(packageGroup: string, name: string, kind: DeclarationKind): DeclarationFact | undefined;
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
  const indexKey = (packageGroup: string, name: string, kind: DeclarationKind): string =>
    `${packageGroup}\0${name}\0${kind}`;
  return {
    isAmbiguous: (packageGroup, name, kind) => ambiguous.has(indexKey(packageGroup, name, kind)),
    find: (packageGroup, name, kind) => unique.get(indexKey(packageGroup, name, kind)),
  };
}
