/**
 * Inventory differential tests (Tier 2).
 *
 * The most powerful test in the suite: take real TypeScript files from
 * the workspace, enumerate every callable declaration using the
 * TypeScript Compiler API directly, run graph's stage 1 against the
 * same files, and assert the symmetric difference is empty (modulo a
 * documented deny-list of intentional exclusions).
 *
 * If this test passes for the chosen sample files, function detection
 * is correct on real-world TypeScript. If it fails, the failing items
 * are real bugs to investigate — they are not test artifacts.
 */

import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

import { buildCatalog } from './_pipeline.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

interface CallableSite {
  /** A short label for diff output: "function:foo", "method:C.bar", "arrow@line:col". */
  readonly label: string;
  /** 1-based line of the declaration's start. */
  readonly line: number;
  /** 0-based column of the declaration's start. */
  readonly column: number;
  /** Project-relative file path (graph's filePath format). */
  readonly filePath: string;
  /** A coarse classification mirroring graph's FunctionKind. */
  readonly kind:
    | 'function'
    | 'method'
    | 'arrow'
    | 'constructor'
    | 'getter'
    | 'setter'
    | 'function-expression';
}

/**
 * Walk a single source file and enumerate every callable declaration
 * the TypeScript Compiler API would surface.
 *
 * Excludes — these are the intentionally-excluded shapes (matching
 * graph's design). They are documented inline to keep the test honest:
 * if graph silently misses any of these the negative tests in
 * inventory-shape-coverage.test.ts catch it; this test only asserts
 * positive parity for shapes that should be in the catalog.
 *
 *  - MethodSignature, PropertySignature, IndexSignature on
 *    InterfaceDeclaration / TypeLiteralNode — type-level only, no body.
 *  - FunctionTypeNode / ConstructorTypeNode in a type-position context.
 *  - Function declarations / methods with no body (overload signatures,
 *    abstract members, ambient `declare`).
 */
function enumerateCallablesFromTs(
  sourceFile: ts.SourceFile,
  filePathProjectRel: string,
): CallableSite[] {
  const out: CallableSite[] = [];
  const enclosingClass: string[] = [];

  function siteOf(node: ts.Node): { line: number; column: number } {
    const start = node.getStart(sourceFile);
    const lc = sourceFile.getLineAndCharacterOfPosition(start);
    return { line: lc.line + 1, column: lc.character };
  }

  function visit(node: ts.Node): void {
    // Skip type-position descendants entirely — anything inside a
    // TypeNode (function type alias, type literal, interface body) is
    // not a callable.
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeLiteralNode(node) ||
      ts.isFunctionTypeNode(node) ||
      ts.isConstructorTypeNode(node)
    ) {
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = node.name?.text ?? '<anon-class>';
      enclosingClass.push(className);
      ts.forEachChild(node, visit);
      enclosingClass.pop();
      return;
    }

    if (ts.isFunctionDeclaration(node)) {
      // Body-less declarations (overload signatures, ambient declares)
      // are not callables — graph excludes them by design.
      if (!node.body) {
        ts.forEachChild(node, visit);
        return;
      }
      const name = node.name?.text ?? '<anon>';
      const { line, column } = siteOf(node);
      out.push({
        label: `function:${name}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'function',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isMethodDeclaration(node)) {
      // Abstract / overload-signature methods have no body.
      if (!node.body) {
        ts.forEachChild(node, visit);
        return;
      }
      const cls = enclosingClass.at(-1) ?? '<anon-class>';
      const nameNode = node.name;
      let name: string;
      if (ts.isIdentifier(nameNode)) name = nameNode.text;
      else if (ts.isStringLiteral(nameNode)) name = nameNode.text;
      else if (ts.isPrivateIdentifier(nameNode)) name = nameNode.text;
      else name = '<computed>';
      const { line, column } = siteOf(node);
      out.push({
        label: `method:${cls}.${name}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'method',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isConstructorDeclaration(node)) {
      if (!node.body) {
        ts.forEachChild(node, visit);
        return;
      }
      const cls = enclosingClass.at(-1) ?? '<anon-class>';
      const { line, column } = siteOf(node);
      out.push({
        label: `constructor:${cls}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'constructor',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isGetAccessor(node)) {
      if (!node.body) {
        ts.forEachChild(node, visit);
        return;
      }
      const cls = enclosingClass.at(-1) ?? '<anon-class>';
      const nameNode = node.name;
      const name =
        ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : '<computed>';
      const { line, column } = siteOf(node);
      out.push({
        label: `get:${cls}.${name}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'getter',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isSetAccessor(node)) {
      if (!node.body) {
        ts.forEachChild(node, visit);
        return;
      }
      const cls = enclosingClass.at(-1) ?? '<anon-class>';
      const nameNode = node.name;
      const name =
        ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : '<computed>';
      const { line, column } = siteOf(node);
      out.push({
        label: `set:${cls}.${name}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'setter',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isArrowFunction(node)) {
      const { line, column } = siteOf(node);
      out.push({
        label: `arrow@${String(line)}:${String(column)}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'arrow',
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionExpression(node)) {
      const { line, column } = siteOf(node);
      const name = node.name?.text ?? `fn-expr@${String(line)}:${String(column)}`;
      out.push({
        label: `function-expression:${name}`,
        line,
        column,
        filePath: filePathProjectRel,
        kind: 'function-expression',
      });
      ts.forEachChild(node, visit);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return out;
}

/** Reduce a graph occurrence to a (line, column, kind) site for comparison. */
function occToSite(occ: FunctionOccurrence): { line: number; column: number; kind: string } {
  // Map graph's FunctionKind → the coarser kinds enumerateCallablesFromTs uses.
  let kind: string = occ.kind;
  if (occ.kind === 'function-declaration') kind = 'function';
  return { line: occ.line, column: occ.column, kind };
}

function siteKey(s: { line: number; column: number; kind: string }): string {
  return `${s.kind}@${String(s.line)}:${String(s.column)}`;
}

/**
 * For a given file in the workspace, run graph's stage 1, run a parallel
 * TS-Compiler-API enumeration, and return the symmetric difference of
 * (line, column, kind) sites.
 */
function differentialFor(
  filePathProjectRel: string,
  projectDir: string,
): {
  onlyInTs: CallableSite[];
  onlyInGraph: FunctionOccurrence[];
  graphCount: number;
  tsCount: number;
} {
  const discovery = discoverFiles({ projectDir });
  const inv = buildCatalog({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  const catalog: Catalog = inv.catalog;

  const targetSf = inv.program
    .getSourceFiles()
    .find(
      (sf) =>
        relative(discovery.projectDirAbs, sf.fileName).split(/[/\\]/).join('/') ===
        filePathProjectRel,
    );
  if (!targetSf) {
    throw new Error(
      `Could not find ${filePathProjectRel} in program; tsconfig may not include it.`,
    );
  }

  const tsCallables = enumerateCallablesFromTs(targetSf, filePathProjectRel);
  const tsSites = new Set(tsCallables.map((c) => siteKey(c)));

  const graphOccs: FunctionOccurrence[] = [];
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      // module-init is a graph-only synthesis; not a real callable from
      // the TS-API perspective. Exclude from the differential.
      if (o.kind === 'module-init') continue;
      if (o.filePath === filePathProjectRel) graphOccs.push(o);
    }
  }
  const graphSites = new Set(graphOccs.map((o) => siteKey(occToSite(o))));

  const onlyInTs = tsCallables.filter((c) => !graphSites.has(siteKey(c)));
  const onlyInGraph = graphOccs.filter((o) => !tsSites.has(siteKey(occToSite(o))));

  return {
    onlyInTs,
    onlyInGraph,
    graphCount: graphOccs.length,
    tsCount: tsCallables.length,
  };
}

interface SampleSpec {
  readonly packageDir: string;
  readonly relativePath: string;
}

const SAMPLES: readonly SampleSpec[] = [
  { packageDir: 'packages/cli', relativePath: 'src/index.ts' },
  { packageDir: 'packages/fitness/engine', relativePath: 'src/framework/define-check.ts' },
  { packageDir: 'packages/contracts', relativePath: 'src/types.ts' },
  { packageDir: 'packages/languages/lang-typescript', relativePath: 'src/ast-utilities.ts' },
  // Layer 5 Phase 3 (audit 2026-05-22 F3) moved the FitView controller
  // out of cli/ui into the fitness package as fit-runner.tsx; the new
  // file is the JSX-rich sample that this differential test exercises.
  { packageDir: 'packages/fitness/engine', relativePath: 'src/cli/fit-runner.tsx' },
];

describe('Tier 2 — differential test against TS Compiler API on real workspace files', () => {
  for (const sample of SAMPLES) {
    it(`graph stage 1 finds the same callables as the TS API for ${sample.packageDir}/${sample.relativePath}`, () => {
      const projectDir = resolve(REPO_ROOT, sample.packageDir);
      const { onlyInTs, onlyInGraph, graphCount, tsCount } = differentialFor(
        sample.relativePath,
        projectDir,
      );

      const tsLines = onlyInTs
        .map((c) => `${c.label} at ${String(c.line)}:${String(c.column)}`)
        .join('\n  - ');
      const graphLines = onlyInGraph
        .map((o) => `${o.kind} ${o.simpleName} at ${String(o.line)}:${String(o.column)}`)
        .join('\n  - ');
      const missedLine =
        onlyInTs.length > 0
          ? `Missed by graph (${String(onlyInTs.length)}):\n  - ${tsLines}`
          : 'Missed by graph: none';
      const spuriousLine =
        onlyInGraph.length > 0
          ? `Spurious in graph (${String(onlyInGraph.length)}):\n  - ${graphLines}`
          : 'Spurious in graph: none';
      const detail = [
        `Sample: ${sample.packageDir}/${sample.relativePath}`,
        `graph found: ${String(graphCount)} callables`,
        `TS API found: ${String(tsCount)} callables`,
        missedLine,
        spuriousLine,
      ].join('\n');

      // Sanity floor: types-only files (e.g. types.ts) may have zero
      // callables. All other samples should have at least one.
      expect(graphCount, detail).toBe(tsCount);
      expect(onlyInTs, `\n${detail}`).toEqual([]);
      expect(onlyInGraph, `\n${detail}`).toEqual([]);
    });
  }

  it('coverage sanity: the 5 sample files together expose a substantial number of callables', () => {
    // Make sure our chosen sample is non-trivial — i.e. we're actually
    // exercising graph's detection on real code, not just empty type files.
    // Empirically observed callable counts on the post-Phase-3 layout
    // (the FitView controller moved from cli/ui/components into
    // fitness/cli/fit-runner.tsx). The exact totals are not pinned —
    // see the sanity floor below — but the spread roughly mirrors:
    //   packages/cli/src/index.ts                                ~26
    //   packages/fitness/engine/src/framework/define-check.ts    ~12
    //   packages/contracts/src/types.ts                            0  (types-only)
    //   packages/languages/lang-typescript/src/ast-utilities.ts  ~20
    //   packages/fitness/engine/src/cli/fit-runner.tsx           >0  (large JSX file)
    const perFile: Record<string, number> = {};
    let totalCallables = 0;
    for (const sample of SAMPLES) {
      const projectDir = resolve(REPO_ROOT, sample.packageDir);
      const { tsCount } = differentialFor(sample.relativePath, projectDir);
      perFile[`${sample.packageDir}/${sample.relativePath}`] = tsCount;
      totalCallables += tsCount;
    }
    const detail = JSON.stringify(perFile, null, 2);
    expect(totalCallables, detail).toBeGreaterThanOrEqual(30);
    // Belt-and-braces: at least 4 of the 5 samples are non-empty.
    const nonEmpty = Object.values(perFile).filter((n) => n > 0).length;
    expect(nonEmpty, detail).toBeGreaterThanOrEqual(4);
  });
});
