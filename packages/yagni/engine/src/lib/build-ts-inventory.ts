/**
 * build-ts-inventory — yagni's OWN TypeScript function-body inventory, the input to its
 * duplicate detector. yagni builds this in-process (no `@opensip-cli/graph` dependency,
 * ADR-0064) by walking the TS AST exactly as graph-typescript's inventory does, so the
 * two tools produce byte-identical `CloneCandidate`s and cannot diverge (the cross-tool
 * parity test is the standing guard).
 *
 * Byte-identity contract (must match `graph-typescript/inventory-helpers/hash-body.ts`
 * + the inventory visitors):
 *   - bodyHash/bodySize = `digestCanonicalBody(normalizeWhitespace(stripComments(
 *     sourceFile.text.slice(node.getStart(sf), node.getEnd()))))` — same span, same
 *     `stripComments` (lang-typescript), same digest (clone-detection).
 *   - line = getStart line + 1 (1-based); column = getStart character (0-based);
 *     endLine = getEnd line + 1. bodyLines fallback (`endLine − line + 1`) equals graph's
 *     feature column (features.ts:132).
 *   - inTestFile via the shared `isTestFilePath` (Phase 1 Task 1.3a) — the single predicate.
 *   - kind ∈ the eligible set only (function-declaration/method/constructor/getter/setter).
 *     Arrows / function-expressions / module-init are excluded by policy on both tools, so
 *     emitting only the eligible kinds yields the same post-filter groups as graph.
 *
 * Body source text NEVER leaves this parse — only the hash/size/location enter a
 * `CloneCandidate` (H4).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  digestCanonicalBody,
  isTestFilePath,
  normalizeWhitespace,
  type CloneCandidate,
  type FunctionKind,
} from '@opensip-cli/clone-detection';
import { getMeter, withSpan } from '@opensip-cli/core';
import { getSharedSourceFile, stripComments } from '@opensip-cli/lang-typescript';
import ts from 'typescript';

import { walkTypeScriptFiles } from './walk-typescript-files.js';

/** A function body larger than this is skipped (resource bound, H3). 1 MB matches unused-config-surface. */
const MAX_SOURCE_FILE_BYTES = 1_000_000;

/**
 * Build the function-body inventory for `cwd` (optionally scoped to `pathRoots`).
 * Walks ALL TS files (including test files) so `inTestFile` stamping is complete and
 * cross-file duplicates are seen; the policy (`findDuplicateBodies`) excludes test-file
 * candidates, exactly as graph does.
 */
export function buildTsInventory(cwd: string, pathRoots?: readonly string[]): CloneCandidate[] {
  return withSpan('opensip-cli-yagni', 'yagni.build_ts_inventory', () => {
    const start = Date.now();
    const filePaths = walkTypeScriptFiles(cwd, true, pathRoots);
    const candidates: CloneCandidate[] = [];
    const packageByDir = new Map<string, string | undefined>();
    for (const filePath of filePaths) {
      const content = readBoundedSource(filePath);
      if (content === undefined) continue;
      const sourceFile = getSharedSourceFile(filePath, content);
      if (!sourceFile) continue;
      const projectRel = relative(cwd, filePath).split('\\').join('/');
      const ctx: FileContext = {
        sourceFile,
        projectRel,
        inTestFile: isTestFilePath(projectRel),
        pkg: resolvePackage(dirname(filePath), cwd, packageByDir),
      };
      collectFunctions(sourceFile, ctx, undefined, candidates);
    }
    recordParseDuration(Date.now() - start, candidates.length);
    return candidates;
  });
}

interface FileContext {
  readonly sourceFile: ts.SourceFile;
  readonly projectRel: string;
  readonly inTestFile: boolean;
  readonly pkg: string | undefined;
}

/**
 * Recursively collect eligible function-like declarations, tracking the enclosing class
 * name for the qualified name (mirrors graph-typescript's visitors).
 */
function collectFunctions(
  node: ts.Node,
  ctx: FileContext,
  enclosingClass: string | undefined,
  out: CloneCandidate[],
): void {
  const candidate = candidateFor(node, ctx, enclosingClass);
  if (candidate) out.push(candidate);
  const nextClass = ts.isClassDeclaration(node) && node.name ? node.name.text : enclosingClass;
  ts.forEachChild(node, (child) => collectFunctions(child, ctx, nextClass, out));
}

function candidateFor(
  node: ts.Node,
  ctx: FileContext,
  enclosingClass: string | undefined,
): CloneCandidate | undefined {
  const shape = classify(node, enclosingClass, ctx.projectRel);
  if (shape === undefined) return undefined;

  const sf = ctx.sourceFile;
  const startLC = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const endLC = sf.getLineAndCharacterOfPosition(node.getEnd());
  const canonical = normalizeWhitespace(
    stripComments(sf.text.slice(node.getStart(sf), node.getEnd())),
  );
  const digest = digestCanonicalBody(canonical);

  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    kind: shape.kind,
    inTestFile: ctx.inTestFile,
    filePath: ctx.projectRel,
    line: startLC.line + 1,
    column: startLC.character,
    endLine: endLC.line + 1,
    simpleName: shape.simpleName,
    qualifiedName: shape.qualifiedName,
    ...(digest.signature === undefined ? {} : { bodySignature: digest.signature }),
    ...(ctx.pkg === undefined ? {} : { package: ctx.pkg }),
  };
}

interface Shape {
  readonly kind: FunctionKind;
  readonly simpleName: string;
  readonly qualifiedName: string;
}

/**
 * Classify a node as one of the ELIGIBLE function kinds (the kinds duplicate detection
 * considers — arrows / function-expressions / module-init are excluded by policy, so they
 * are not emitted). Returns undefined for everything else and for body-less declarations
 * (overload signatures / ambient `declare`), which graph drops too.
 */
function classify(
  node: ts.Node,
  enclosingClass: string | undefined,
  projectRel: string,
): Shape | undefined {
  const base = projectRel.replace(/\.tsx?$/, '');
  const inClass = (name: string): string =>
    enclosingClass ? `${base}.${enclosingClass}.${name}` : `${base}.${name}`;

  if (ts.isFunctionDeclaration(node)) {
    const name = functionDeclName(node);
    return name === undefined
      ? undefined
      : { kind: 'function-declaration', simpleName: name, qualifiedName: `${base}.${name}` };
  }
  if (ts.isConstructorDeclaration(node) && node.body) {
    return {
      kind: 'constructor',
      simpleName: 'constructor',
      qualifiedName: inClass('constructor'),
    };
  }
  if (ts.isMethodDeclaration(node) && node.body) {
    const name = memberName(node);
    return { kind: 'method', simpleName: name, qualifiedName: inClass(name) };
  }
  if (ts.isGetAccessor(node) && node.body) return accessorShape(node, 'getter', inClass);
  if (ts.isSetAccessor(node) && node.body) return accessorShape(node, 'setter', inClass);
  return undefined;
}

/** Function-declaration name, or undefined for body-less (overload/ambient) and unnamed non-default. */
function functionDeclName(node: ts.FunctionDeclaration): string | undefined {
  if (!node.body) return undefined;
  if (node.name) return node.name.text;
  const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
  return isDefault ? '<default>' : undefined;
}

/** Member name for a method/accessor, or `<computed>` for a computed property name. */
function memberName(node: ts.MethodDeclaration | ts.AccessorDeclaration): string {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
    ? node.name.text
    : '<computed>';
}

function accessorShape(
  node: ts.AccessorDeclaration,
  kind: FunctionKind,
  inClass: (name: string) => string,
): Shape {
  const name = memberName(node);
  return { kind, simpleName: name, qualifiedName: inClass(name) };
}

/** Read a source file, skipping anything over the byte bound (H3). */
function readBoundedSource(filePath: string): string | undefined {
  try {
    if (statSync(filePath).size > MAX_SOURCE_FILE_BYTES) return undefined;
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Nearest-`package.json` name for a directory, walking UP to (and not past) the project
 * root — mirrors graph's `pkgOf`/`assignPackages` so cross-package aggregation matches.
 * Memoized per directory.
 */
function resolvePackage(
  dir: string,
  cwd: string,
  cache: Map<string, string | undefined>,
): string | undefined {
  const cached = cache.get(dir);
  if (cached !== undefined || cache.has(dir)) return cached;
  let resolved: string | undefined;
  try {
    const pkg = readFileSync(join(dir, 'package.json'), 'utf8');
    const name = (JSON.parse(pkg) as { name?: unknown }).name;
    if (typeof name === 'string') resolved = name;
  } catch {
    const parent = dirname(dir);
    if (dir !== cwd && parent !== dir && dir.startsWith(cwd)) {
      resolved = resolvePackage(parent, cwd, cache);
    }
  }
  cache.set(dir, resolved);
  return resolved;
}

/**
 * O1 — record the inventory parse duration on the opt-in OTel histogram. Fire-and-forget;
 * a no-op when no telemetry backend is configured (ADR-0004). Bounded-cardinality labels
 * only — never paths/symbols/counts as label values. Body text never reaches a label.
 */
function recordParseDuration(durationMs: number, candidateCount: number): void {
  try {
    getMeter('opensip-cli')
      .createHistogram('opensip_cli.yagni.inventory.parse_duration_ms')
      .record(durationMs, { tool: 'yagni', outcome: candidateCount > 0 ? 'ok' : 'empty' });
  } catch {
    /* telemetry is best-effort; never affects the run */
  }
}
