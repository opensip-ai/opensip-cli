/**
 * Catalog builder — drives a TypeScript program over a project, walks every
 * source file, and emits FileNode + FunctionNode records.
 *
 * The builder runs in three passes:
 *
 *   1. Discover the tsconfig, build a `ts.Program`, and acquire its TypeChecker.
 *   2. For each source file: walk function-like declarations, hash their bodies,
 *      and emit FunctionNode records. Collect every call expression as a
 *      `CallSite` with the resolver's verdict on what it dispatches to.
 *   3. Build cross-cutting indexes (byContentHash + callers).
 *
 * Resolution behavior is controlled by `BuilderOptions.resolverMode`:
 *
 *   - `'unknown'` (P1): every call site is `resolution: 'unknown'`.
 *   - `'static'`  (P2): direct calls resolve via TypeChecker; method calls stay unknown.
 *   - `'full'`    (P3): static + polymorphic dispatch (`obj.method()` → all impls).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';

import ts from 'typescript';

import { hashFileContent, hashFunctionBody, makeFunctionId } from './ids.js';
import { buildIndexes } from './index-builder.js';
import {
  CATALOG_LANGUAGE,
  CATALOG_TOOL,
  CATALOG_VERSION,
  type Catalog,
  type CallConfidence,
  type CallResolution,
  type CallSite,
  type FileImport,
  type FileNode,
  type FunctionKind,
  type FunctionNode,
  type FunctionParam,
  type FunctionVisibility,
} from './types.js';

/** Resolver-mode discriminator — controls how aggressively we resolve calls. */
export type ResolverMode = 'unknown' | 'static' | 'full';

/** Options accepted by the catalog builder. */
export interface BuilderOptions {
  /** Project root — every path stored in the catalog is relative to this. */
  readonly projectDir: string;
  /** Path to tsconfig.json. The builder loads it via ts.parseJsonConfigFileContent. */
  readonly tsConfigPath: string;
  /** Resolver behavior — see file header. Default: 'full'. */
  readonly resolverMode?: ResolverMode;
  /**
   * If non-null, the builder uses this clock for `builtAt`. Production callers
   * leave it undefined; tests inject a deterministic value.
   */
  readonly now?: () => Date;
}

/** Result of running the builder once. */
export interface BuildResult {
  readonly catalog: Catalog;
  /** Files the builder failed to parse (best-effort; doesn't throw). */
  readonly parseErrors: readonly { filePath: string; reason: string }[];
}

/** Run the catalog builder once. */
export function buildCatalog(options: BuilderOptions): BuildResult {
  const resolverMode = options.resolverMode ?? 'full';
  const now = (options.now ?? (() => new Date()))().toISOString();

  const program = createProgramFromTsConfig(options.tsConfigPath);
  const checker = program.getTypeChecker();

  // Pre-compute, for the whole program, the implementations index used by the
  // polymorphic resolver. Built once per program; reused by every call site
  // we visit. Keyed on the interface/abstract-class symbol id so lookups are
  // O(1) per polymorphic call.
  const implsIndex =
    resolverMode === 'full' ? buildImplementationsIndex(program, checker) : new Map<number, ts.ClassDeclaration[]>();

  const fileNodes: FileNode[] = [];
  const functionNodes: FunctionNode[] = [];
  const parseErrors: { filePath: string; reason: string }[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    // Skip files outside the project (node_modules, etc.) — the catalog is
    // about user code, not vendor code. We use isAbsolute as a safety net;
    // ts already normalizes paths.
    const abs = sourceFile.fileName;
    if (!abs.startsWith(options.projectDir + '/') && abs !== options.projectDir) continue;

    try {
      const { file, fns } = visitFile({
        sourceFile,
        projectDir: options.projectDir,
        checker,
        resolverMode,
        implsIndex,
      });
      fileNodes.push(file);
      functionNodes.push(...fns);
    } catch (error) {
      parseErrors.push({
        filePath: relative(options.projectDir, abs),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const indexes = buildIndexes(functionNodes);

  return {
    catalog: {
      version: CATALOG_VERSION,
      tool: CATALOG_TOOL,
      language: CATALOG_LANGUAGE,
      builtAt: now,
      tsConfigPath: options.tsConfigPath,
      tsCompilerVersion: ts.version,
      files: fileNodes,
      functions: functionNodes,
      indexes,
    },
    parseErrors,
  };
}

// ---------------------------------------------------------------------------
// Program construction
// ---------------------------------------------------------------------------

/** Load a tsconfig and create a `ts.Program` from it. */
export function createProgramFromTsConfig(tsConfigPath: string): ts.Program {
  if (!existsSync(tsConfigPath)) {
    throw new Error(`tsconfig not found at ${tsConfigPath}`);
  }
  const configText = readFileSync(tsConfigPath, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(tsConfigPath, configText);
  if (parsed.error) {
    throw new Error(`Invalid tsconfig: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`);
  }
  const configRoot = dirname(tsConfigPath);
  const cmd = ts.parseJsonConfigFileContent(parsed.config, ts.sys, configRoot);
  if (cmd.errors.length > 0) {
    const first = cmd.errors[0];
    throw new Error(
      `tsconfig parse error: ${ts.flattenDiagnosticMessageText(first.messageText, '\n')}`,
    );
  }
  return ts.createProgram({
    rootNames: cmd.fileNames,
    options: cmd.options,
  });
}

// ---------------------------------------------------------------------------
// Per-file visitor
// ---------------------------------------------------------------------------

interface VisitContext {
  readonly sourceFile: ts.SourceFile;
  readonly projectDir: string;
  readonly checker: ts.TypeChecker;
  readonly resolverMode: ResolverMode;
  readonly implsIndex: ReadonlyMap<number, ts.ClassDeclaration[]>;
}

interface VisitResult {
  readonly file: FileNode;
  readonly fns: FunctionNode[];
}

function visitFile(ctx: VisitContext): VisitResult {
  const relPath = relative(ctx.projectDir, ctx.sourceFile.fileName);
  const text = ctx.sourceFile.getFullText();
  const contentHash = hashFileContent(text);
  const inTestPath = isTestPath(relPath);
  const isGenerated = isGeneratedFile(text);

  const fns: FunctionNode[] = [];
  const fnIds: string[] = [];

  // Walk the AST collecting function-like declarations. For each, record
  // the function and its outgoing call sites.
  const visit = (node: ts.Node, enclosingClass?: string): void => {
    const fnInfo = describeFunction(node, ctx.sourceFile);
    if (fnInfo) {
      const calls = collectCallSites({ ...ctx, ownerNode: node, enclosingFn: fnInfo.simpleName });
      const bodyText = getFunctionBodyText(node, ctx.sourceFile);
      const bodyHash = hashFunctionBody(bodyText);
      const id = makeFunctionId({ contentHash: bodyHash, filePath: relPath, simpleName: fnInfo.simpleName });
      const fn: FunctionNode = {
        id,
        qualifiedName: buildQualifiedName(relPath, enclosingClass, fnInfo.simpleName),
        simpleName: fnInfo.simpleName,
        filePath: relPath,
        line: fnInfo.line,
        column: fnInfo.column,
        endLine: fnInfo.endLine,
        kind: fnInfo.kind,
        params: fnInfo.params,
        ...(fnInfo.returnType ? { returnType: fnInfo.returnType } : {}),
        ...(fnInfo.exportedFrom ? { exportedFrom: relPath } : {}),
        visibility: fnInfo.visibility,
        ...(enclosingClass ? { enclosingClass } : {}),
        decorators: fnInfo.decorators,
        directSideEffects: null,
        inTestFile: inTestPath,
        definedInGenerated: isGenerated,
        calls,
      };
      fns.push(fn);
      fnIds.push(id);
    }

    // Recurse — descend into class bodies with the class name as enclosingClass.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = node.name?.getText(ctx.sourceFile);
      ts.forEachChild(node, (child) => visit(child, className));
    } else {
      ts.forEachChild(node, (child) => visit(child, enclosingClass));
    }
  };
  ts.forEachChild(ctx.sourceFile, (n) => visit(n));

  const file: FileNode = {
    path: relPath,
    contentHash,
    languageId: 'typescript',
    inTestPath,
    imports: collectImports(ctx.sourceFile),
    definesFunctions: fnIds,
  };
  return { file, fns };
}

// ---------------------------------------------------------------------------
// Function-shape detection
// ---------------------------------------------------------------------------

interface FunctionShape {
  readonly simpleName: string;
  readonly kind: FunctionKind;
  readonly params: readonly FunctionParam[];
  readonly returnType?: string;
  readonly exportedFrom?: boolean;
  readonly visibility: FunctionVisibility;
  readonly decorators: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
}

function describeFunction(node: ts.Node, sf: ts.SourceFile): FunctionShape | null {
  if (ts.isFunctionDeclaration(node) && node.body) return describeFunctionDecl(node, sf);
  if (ts.isMethodDeclaration(node) && node.body) return describeMethodDecl(node, sf);
  if (ts.isConstructorDeclaration(node) && node.body) return describeCtor(node);
  if (ts.isGetAccessorDeclaration(node) && node.body) return describeAccessor(node, sf, 'getter');
  if (ts.isSetAccessorDeclaration(node) && node.body) return describeAccessor(node, sf, 'setter');
  if (ts.isVariableDeclaration(node) && node.initializer) return describeVariableDecl(node, sf);
  return null;
}

function describeFunctionDecl(node: ts.FunctionDeclaration, sf: ts.SourceFile): FunctionShape {
  return baseShape({
    node,
    sf,
    simpleName: node.name?.getText(sf) ?? '<anonymous>',
    kind: 'function',
    visibility: detectVisibility(node),
    params: node.parameters,
    returnType: node.type?.getText(sf),
    decorators: getDecorators(node),
  });
}

function describeMethodDecl(node: ts.MethodDeclaration, sf: ts.SourceFile): FunctionShape {
  return baseShape({
    node,
    sf,
    simpleName: node.name.getText(sf),
    kind: 'method',
    visibility: detectMethodVisibility(node),
    params: node.parameters,
    returnType: node.type?.getText(sf),
    decorators: getDecorators(node),
  });
}

function describeCtor(node: ts.ConstructorDeclaration): FunctionShape {
  return baseShape({
    node,
    sf: node.getSourceFile(),
    simpleName: 'constructor',
    kind: 'constructor',
    visibility: 'module-local',
    params: node.parameters,
    decorators: getDecorators(node),
  });
}

function describeAccessor(
  node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  sf: ts.SourceFile,
  kind: 'getter' | 'setter',
): FunctionShape {
  return baseShape({
    node,
    sf,
    simpleName: node.name.getText(sf),
    kind,
    visibility: detectMethodVisibility(node),
    params: node.parameters,
    decorators: getDecorators(node),
  });
}

function describeVariableDecl(node: ts.VariableDeclaration, sf: ts.SourceFile): FunctionShape | null {
  const init = node.initializer;
  if (!init) return null;
  if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return null;
  return baseShape({
    node: init,
    sf,
    simpleName: node.name.getText(sf),
    kind: 'arrow',
    visibility: isExportedVariableDecl(node) ? 'exported' : 'module-local',
    params: init.parameters,
    returnType: init.type?.getText(sf),
    decorators: [],
  });
}

function baseShape(opts: {
  node: ts.SignatureDeclaration & { body?: ts.Node };
  sf: ts.SourceFile;
  simpleName: string;
  kind: FunctionKind;
  visibility: FunctionVisibility;
  params: ts.NodeArray<ts.ParameterDeclaration>;
  returnType?: string;
  decorators: readonly string[];
}): FunctionShape {
  const startPos = opts.node.getStart(opts.sf);
  const endPos = opts.node.getEnd();
  const start = opts.sf.getLineAndCharacterOfPosition(startPos);
  const end = opts.sf.getLineAndCharacterOfPosition(endPos);
  return {
    simpleName: opts.simpleName,
    kind: opts.kind,
    params: opts.params.map((p) => ({
      name: p.name.getText(opts.sf),
      optional: p.questionToken !== undefined || p.initializer !== undefined,
      rest: p.dotDotDotToken !== undefined,
    })),
    ...(opts.returnType ? { returnType: opts.returnType } : {}),
    ...(opts.visibility === 'exported' ? { exportedFrom: true } : {}),
    visibility: opts.visibility,
    decorators: opts.decorators,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
  };
}

function detectVisibility(node: ts.FunctionDeclaration): FunctionVisibility {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return 'exported';
  return 'module-local';
}

function detectMethodVisibility(
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): FunctionVisibility {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
  return 'module-local';
}

function isExportedVariableDecl(node: ts.VariableDeclaration): boolean {
  // const foo = ...; — walk up to the VariableStatement and check for `export`.
  const stmt = node.parent?.parent;
  if (stmt && ts.isVariableStatement(stmt)) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
  }
  return false;
}

function getDecorators(node: ts.Node): readonly string[] {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!decorators || decorators.length === 0) return [];
  return decorators.map((d) => d.expression.getText());
}

function getFunctionBodyText(node: ts.Node, sf: ts.SourceFile): string {
  // For each function-like, return the body text. If no body (declaration
  // only — already filtered out), use the whole node's text as a fallback.
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.body
  ) {
    return node.body.getText(sf);
  }
  if (ts.isArrowFunction(node)) {
    return node.body.getText(sf);
  }
  return node.getText(sf);
}

function buildQualifiedName(
  relPath: string,
  enclosingClass: string | undefined,
  simpleName: string,
): string {
  // Strip extension for readability.
  const noExt = relPath.replace(/\.[^/.]+$/, '');
  const tail = enclosingClass ? `${enclosingClass}.${simpleName}` : simpleName;
  return `${noExt}.${tail}`;
}

function isTestPath(relPath: string): boolean {
  return /(?:__tests__\/|\.(?:test|spec)\.[mc]?[tj]sx?$)/.test(relPath);
}

function isGeneratedFile(text: string): boolean {
  // The first 1KB is plenty to find an @generated marker.
  const head = text.slice(0, 1024);
  return /@generated\b|do not edit by hand/i.test(head);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function collectImports(sf: ts.SourceFile): readonly FileImport[] {
  const imports: FileImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const named = extractImportedBindings(stmt.importClause);
    imports.push({ specifier, resolvedPath: null, imported: named });
  }
  return imports;
}

function extractImportedBindings(
  clause: ts.ImportClause | undefined,
): { local: string; external: string }[] {
  const out: { local: string; external: string }[] = [];
  if (!clause) return out;
  if (clause.name) {
    out.push({ local: clause.name.text, external: 'default' });
  }
  if (clause.namedBindings) {
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.push({
          local: el.name.text,
          external: el.propertyName ? el.propertyName.text : el.name.text,
        });
      }
    } else {
      out.push({ local: clause.namedBindings.name.text, external: '*' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call-site collection
// ---------------------------------------------------------------------------

interface CallContext extends VisitContext {
  readonly ownerNode: ts.Node;
  readonly enclosingFn: string;
}

function collectCallSites(ctx: CallContext): readonly CallSite[] {
  const calls: CallSite[] = [];
  const ownerStart = ctx.ownerNode.getStart(ctx.sourceFile);
  const ownerEnd = ctx.ownerNode.getEnd();

  // Walk descendant CallExpressions of the function body. We don't recurse
  // into nested function-likes — those become their own FunctionNodes with
  // their own call lists.
  const visit = (node: ts.Node): void => {
    // Skip nested function declarations / methods / arrow / function-expr.
    if (node !== ctx.ownerNode && isFunctionLike(node)) return;

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const start = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile));
      const text = node.getText(ctx.sourceFile);
      const verdict = resolveCall(node, ctx);
      // Bound by the owning function range so we don't bleed past it.
      if (node.getStart(ctx.sourceFile) >= ownerStart && node.getEnd() <= ownerEnd) {
        calls.push({
          line: start.line + 1,
          column: start.character + 1,
          resolvedTo: verdict.resolvedTo,
          resolution: verdict.resolution,
          confidence: verdict.confidence,
          text: text.length > 200 ? text.slice(0, 197) + '...' : text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  // Start from the body if it has one — else from the owner itself.
  const body = getOwnerBody(ctx.ownerNode);
  if (body) visit(body);
  else visit(ctx.ownerNode);
  return calls;
}

function getOwnerBody(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node)) {
    return node.body ?? null;
  }
  if (ts.isArrowFunction(node)) return node.body;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (ts.isArrowFunction(node.initializer)) return node.initializer.body;
    if (ts.isFunctionExpression(node.initializer)) return node.initializer.body ?? null;
  }
  return null;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

// ---------------------------------------------------------------------------
// Call resolution
// ---------------------------------------------------------------------------

interface ResolverVerdict {
  readonly resolvedTo: readonly string[];
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
}

const UNKNOWN_VERDICT: ResolverVerdict = { resolvedTo: [], resolution: 'unknown', confidence: 'low' };

function resolveCall(call: ts.CallExpression | ts.NewExpression, ctx: CallContext): ResolverVerdict {
  if (ctx.resolverMode === 'unknown') return UNKNOWN_VERDICT;

  const expr = call.expression;

  // Direct call: foo(...).
  if (ts.isIdentifier(expr)) {
    return resolveIdentifierCall(expr, ctx);
  }

  // Property access call: foo.bar(...) or this.foo(...).
  if (ts.isPropertyAccessExpression(expr)) {
    if (ctx.resolverMode === 'static') {
      // P2 doesn't try polymorphic dispatch; leave method calls unknown.
      return UNKNOWN_VERDICT;
    }
    return resolvePropertyAccessCall(expr, ctx);
  }

  // Element access (obj[key]) — almost always dynamic.
  if (ts.isElementAccessExpression(expr)) {
    return { resolvedTo: [], resolution: 'dynamic-string', confidence: 'low' };
  }

  return UNKNOWN_VERDICT;
}

function resolveIdentifierCall(id: ts.Identifier, ctx: CallContext): ResolverVerdict {
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return UNKNOWN_VERDICT;
  const decls = sym.declarations ?? [];
  const ids: string[] = [];
  for (const d of decls) {
    const fnId = declarationToFunctionId(d, ctx);
    if (fnId) ids.push(fnId);
  }
  if (ids.length === 0) return UNKNOWN_VERDICT;
  return { resolvedTo: ids, resolution: 'static', confidence: 'high' };
}

function resolvePropertyAccessCall(
  expr: ts.PropertyAccessExpression,
  ctx: CallContext,
): ResolverVerdict {
  const sym = ctx.checker.getSymbolAtLocation(expr.name);
  if (!sym) return UNKNOWN_VERDICT;

  // Static side: the declaration we're nominally calling.
  const decls = sym.declarations ?? [];
  const directIds: string[] = [];
  for (const d of decls) {
    const fnId = declarationToFunctionId(d, ctx);
    if (fnId) directIds.push(fnId);
  }

  // Polymorphic fan-out: if the receiver's type is an interface or abstract
  // class, gather every concrete implementation in the program.
  const receiverType = ctx.checker.getTypeAtLocation(expr.expression);
  const polymorphicIds = polymorphicImpls(receiverType, expr.name.text, ctx);

  const all = uniq([...directIds, ...polymorphicIds]);
  if (all.length === 0) return UNKNOWN_VERDICT;

  // If the only ids came from concrete impl walks, mark as method-dispatch.
  // If there's exactly one direct id and no polymorphic impls, it's static.
  const isPolymorphic = polymorphicIds.length > 0;
  return {
    resolvedTo: all,
    resolution: isPolymorphic ? 'method-dispatch' : 'static',
    confidence: isPolymorphic ? 'medium' : 'high',
  };
}

function declarationToFunctionId(decl: ts.Declaration, ctx: CallContext): string | null {
  // Walk up if the declaration is a name node — TypeScript can return the
  // name identifier for named exports/imports; we want the function-like.
  let node: ts.Node = decl;
  while (node && !isFunctionLike(node) && !ts.isVariableDeclaration(node)) {
    if (!node.parent) break;
    node = node.parent;
  }
  if (!isFunctionLike(node) && !ts.isVariableDeclaration(node)) return null;

  const sf = node.getSourceFile();
  if (!sf || sf.isDeclarationFile) return null;
  const relPath = relative(ctx.projectDir, sf.fileName);

  // The body hash must match the one we computed during the visit pass.
  const bodyText = getFunctionBodyText(node, sf);
  const bodyHash = hashFunctionBody(bodyText);

  // Synthesize the simpleName the visit pass would have used.
  const simpleName = synthesizeSimpleName(node, sf);
  if (!simpleName) return null;

  return makeFunctionId({ contentHash: bodyHash, filePath: relPath, simpleName });
}

function synthesizeSimpleName(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.getText(sf) ?? '<anonymous>';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isVariableDeclaration(node)) return node.name.getText(sf);
  return null;
}

// ---------------------------------------------------------------------------
// Polymorphic dispatch — implementations index
// ---------------------------------------------------------------------------

/**
 * Build a program-wide map from interface/abstract-class symbol id to the
 * list of concrete classes that implement (or extend) it. Used for the
 * polymorphic resolver — see spec §3.2.
 *
 * Keyed on the TypeChecker's internal symbol id. We walk every class
 * declaration in non-declaration source files and follow heritage clauses.
 * Limit: O(class-count) per program — fine for typical projects.
 */
function buildImplementationsIndex(
  program: ts.Program,
  checker: ts.TypeChecker,
): Map<number, ts.ClassDeclaration[]> {
  const out = new Map<number, ts.ClassDeclaration[]>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    ts.forEachChild(sf, (n) => walkForClass(n, sf, checker, out));
  }
  return out;
}

function walkForClass(
  node: ts.Node,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  out: Map<number, ts.ClassDeclaration[]>,
): void {
  if (ts.isClassDeclaration(node)) {
    recordClassHeritage(node, checker, out);
  }
  ts.forEachChild(node, (c) => walkForClass(c, sf, checker, out));
}

function recordClassHeritage(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  out: Map<number, ts.ClassDeclaration[]>,
): void {
  for (const heritage of cls.heritageClauses ?? []) {
    for (const t of heritage.types) {
      const sym = checker.getSymbolAtLocation(t.expression);
      if (!sym) continue;
      const sid = symbolKey(sym, checker);
      if (sid === null) continue;
      const list = out.get(sid);
      if (list) list.push(cls);
      else out.set(sid, [cls]);
    }
  }
}

function symbolKey(sym: ts.Symbol, checker: ts.TypeChecker): number | null {
  // ts internal: getSymbolId is on the type checker but not in the public API.
  // Fall back to a positional key from the symbol's declarations if absent.
  interface WithSymbolId { getSymbolId?: (s: ts.Symbol) => number }
  const internal = checker as unknown as WithSymbolId;
  if (typeof internal.getSymbolId === 'function') {
    return internal.getSymbolId(sym);
  }
  // Positional fallback: hash file + position of first declaration.
  const d = sym.declarations?.[0];
  if (!d) return null;
  const sf = d.getSourceFile();
  return hashStringToNumber(`${sf.fileName}:${d.getStart(sf)}`);
}

function hashStringToNumber(s: string): number {
  let h = 0;
  for (const ch of s) {
    h = Math.trunc((h << 5) - h + (ch.codePointAt(0) ?? 0));
  }
  return h;
}

function polymorphicImpls(
  receiverType: ts.Type,
  methodName: string,
  ctx: CallContext,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const consider = (sym: ts.Symbol | undefined): void => {
    if (!sym) return;
    const key = symbolKey(sym, ctx.checker);
    if (key == null) return;
    const impls = ctx.implsIndex.get(key) ?? [];
    for (const cls of impls) {
      // Find the method on the class with the matching name.
      for (const member of cls.members) {
        if (
          (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
          member.body &&
          member.name.getText(cls.getSourceFile()) === methodName
        ) {
          const id = declarationToFunctionId(member, ctx);
          if (id && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
      }
    }
  };

  // A union type (e.g. `A | B`) widens to each constituent. Otherwise the
  // type itself carries the symbol.
  if (receiverType.isUnion()) {
    for (const sub of receiverType.types) consider(sub.getSymbol());
  } else {
    consider(receiverType.getSymbol());
  }
  return ids;
}

function uniq<T>(arr: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defensive helpers
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative tsconfig path against a base dir. */
export function resolveTsConfigPath(rawPath: string, baseDir: string): string {
  return isAbsolute(rawPath) ? rawPath : resolvePath(baseDir, rawPath);
}
