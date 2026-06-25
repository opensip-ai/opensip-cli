
/**
 * Rust walkProject — emit FunctionOccurrences + CallSiteRecords.
 *
 * Lands in PR 6 of plan docs/plans/10-graph-language-pluggability.md.
 *
 * Identifies the callable shapes:
 *
 *   - `function_item` outside any `impl_item`        → 'function-declaration'
 *   - `function_item` inside an `impl_item`'s body  → 'method'
 *     - `enclosingClass` = the impl's target type (e.g. `Foo` in `impl Foo`)
 *   - `closure_expression`                          → 'arrow'
 *   - one synthetic `<module-init>` per file owning top-level non-fn
 *     items (`use`, `const`, `static`, attribute_item, etc.)
 *
 * Body hashing: sha256 of normalized body text. Normalization:
 *   1. Strip line comments (`// …` to end-of-line).
 *   2. Strip block comments (slash-star ... star-slash, including
 *      nested ones — Rust supports nested block comments, rare though).
 *   3. Collapse whitespace.
 *   String literals are preserved (their content is part of behavior).
 *
 * Call-site records:
 *   - `call_expression` — every Rust function/method call.
 *     The resolver decodes `function`/`method`/`std::fs::read` shapes.
 *   - `macro_invocation` — Rust macros (`println!`, `vec!`, etc.).
 *     Treated as calls so side-effect rules can detect `println!`.
 *   - 'creation' edges — for each `closure_expression` nested inside
 *     a parent function/method/module-init, emit a creation edge so
 *     reachability flows through closures even when the runtime
 *     dispatch site is unresolvable. Mirror of lang-typescript's
 *     `isInlineCallable` rule applied to Rust closures.
 *
 * Test detection:
 *   - File-level: `tests/` directory or `*_test.rs`.
 *   - Function-level: `#[test]` or `#[cfg(test)]` attributes mark
 *     individual functions as test code. We honor the attribute and
 *     set `inTestFile: true` for that occurrence regardless of file
 *     path. NOTE: this means a non-test-file function tagged
 *     `#[test]` is treated as a test. Rust's test conventions allow
 *     this (you can have `#[cfg(test)] mod tests` in any module).
 */

import { relative, sep } from 'node:path';

import {
  childrenOf,
  makeFileClassifier,
  record,
  runWalk,
  synthesizeModuleInit as buildModuleInit,
  type WalkSinks,
} from '@opensip-cli/graph-adapter-common';

import { digestSyntheticBody } from './body-digest.js';
import {
  buildClosureOccurrence,
  buildFunctionOccurrence,
  implTargetName,
  type Frame,
  type WalkCtx,
} from './walk-helpers.js';
import { collectDependencySites } from './walk-use-sites.js';

import type { RustParsedFile, RustParsedProject } from './parse.js';
import type { WalkInput, WalkOutput } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

const TEST_PATH_RE = /(?:^|\/)tests?\//;
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*_test\.rs$/;
const GENERATED_PATH_RE = /\btarget\/|\.generated\./;

const { isTestFile, isGeneratedFile } = makeFileClassifier({
  testRe: TEST_FILE_NAME_RE,
  generatedRe: GENERATED_PATH_RE,
  testPathRe: TEST_PATH_RE,
});

export { isTestFile };

export function walkProject(input: WalkInput<RustParsedProject>): WalkOutput {
  return runWalk({ input, walkFile });
}

function walkFile(
  absPath: string,
  file: RustParsedFile,
  projectDirAbs: string,
  sinks: WalkSinks,
): void {
  const { occurrences: out, callSites, dependencySites } = sinks;
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);

  const qualifiedBase = filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  const moduleInit = buildModuleInit({
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    digestSyntheticBody,
    qualifiedName: `${qualifiedBase}::<module-init>`,
  });
  record(out, moduleInit);

  collectDependencySites(file, moduleInit.bodyHash, dependencySites);

  const ctx: WalkCtx = {
    file,
    filePathProjectRel,
    fileInTestFile: inTestFile,
    definedInGenerated,
    out,
    callSites,
  };
  const initialFrame: Frame = { ownerHash: moduleInit.bodyHash, enclosingImpl: null };

  for (const child of childrenOf(file.tree.rootNode)) visit(child, initialFrame, ctx);
}

// @graph-ignore-next-line graph:cycle -- intentional recursive-descent AST visitor
function visit(node: Node, frame: Frame, ctx: WalkCtx): void {
  if (node.type === 'impl_item') {
    visitImpl(node, frame, ctx);
    return;
  }
  if (node.type === 'function_item') {
    visitFunction(node, frame, ctx);
    return;
  }
  if (node.type === 'closure_expression' && visitClosure(node, frame, ctx)) {
    return;
  }
  if (node.type === 'call_expression' || node.type === 'macro_invocation') {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'call',
    });
  }
  for (const child of childrenOf(node)) visit(child, frame, ctx);
}

function visitImpl(node: Node, frame: Frame, ctx: WalkCtx): void {
  const typeName = implTargetName(node);
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingImpl: typeName };
  for (const child of childrenOf(node)) visit(child, childFrame, ctx);
}

function visitFunction(node: Node, frame: Frame, ctx: WalkCtx): void {
  const occ = buildFunctionOccurrence(node, frame, ctx);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingImpl: null };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of childrenOf(body)) visit(child, childFrame, ctx);
  }
}

function visitClosure(node: Node, frame: Frame, ctx: WalkCtx): boolean {
  const occ = buildClosureOccurrence(node, ctx);
  if (!occ) return false;
  record(ctx.out, occ);
  if (frame.ownerHash !== occ.bodyHash) {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'creation',
      childHash: occ.bodyHash,
    });
  }
  const body = node.childForFieldName('body');
  if (body) {
    visit(body, { ownerHash: occ.bodyHash, enclosingImpl: null }, ctx);
  }
  return true;
}
