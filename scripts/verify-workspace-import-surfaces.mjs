#!/usr/bin/env node
/**
 * verify-workspace-import-surfaces — fail when source imports an undeclared
 * @opensip-cli/* package export (modular boundary Phase 4).
 *
 * Scans only supported TypeScript/JavaScript extensions under workspace `src/`
 * roots using the TypeScript compiler API. Declared package roots and
 * `/internal` test surfaces are accepted; arbitrary undeclared suffixes fail.
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');
const { readWorkspaceExportMap } = require('./lib/workspace-export-map.cjs');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_SOURCE_BYTES = 1024 * 1024;
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * @param {string} repoRoot
 * @returns {ReadonlySet<string>}
 */
export function buildAllowedSpecifiers(repoRoot) {
  const { entries, diagnostics } = readWorkspaceExportMap(repoRoot);
  if (diagnostics.length > 0) {
    throw new Error(
      `export map diagnostics block import-surface verification:\n${diagnostics.join('\n')}`,
    );
  }
  const allowed = new Set(entries.map((e) => e.specifier));
  // Package roots without explicit exports still count as the package name.
  for (const pkg of readWorkspacePackageManifests(repoRoot)) {
    allowed.add(pkg.name);
  }
  return allowed;
}

/**
 * @param {string} dir
 * @param {string} rootReal
 * @param {(file: string) => void} onFile
 */
function walkSrc(dir, rootReal, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let real;
    try {
      real = realpathSync(full);
    } catch {
      continue;
    }
    if (!real.startsWith(rootReal + sep) && real !== rootReal) {
      throw new Error(`source path escapes repository root: ${relative(rootReal, full)}`);
    }
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.runtime' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      walkSrc(full, rootReal, onFile);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.includes('.') ? `.${entry.name.split('.').pop()}` : '';
    if (!SOURCE_EXTS.has(ext)) continue;
    onFile(real);
  }
}

/**
 * @param {string} filePath
 * @param {string} sourceText
 * @param {ReadonlySet<string>} allowed
 * @returns {readonly string[]}
 */
export function findUndeclaredImports(filePath, sourceText, allowed) {
  if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error(`source file exceeds 1 MiB: ${filePath}`);
  }
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  /** @type {string[]} */
  const hits = [];

  const checkSpec = (spec, pos) => {
    if (typeof spec !== 'string' || !spec.startsWith('@opensip-cli/')) return;
    // Exact match or package root of a known package.
    if (allowed.has(spec)) return;
    // Bare package name is always allowed when the package exists (already in set).
    const { line } = sf.getLineAndCharacterOfPosition(pos);
    hits.push(`${filePath}:${line + 1} -> ${spec}`);
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpec(node.moduleSpecifier.text, node.moduleSpecifier.getStart(sf));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      checkSpec(node.moduleReference.expression.text, node.moduleReference.expression.getStart(sf));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpec(node.moduleSpecifier.text, node.moduleSpecifier.getStart(sf));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      checkSpec(node.arguments[0].text, node.arguments[0].getStart(sf));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      checkSpec(node.arguments[0].text, node.arguments[0].getStart(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * @param {string} [repoRoot]
 * @returns {readonly string[]}
 */
export function verifyWorkspaceImportSurfaces(repoRoot = REPO_ROOT) {
  const rootReal = realpathSync(repoRoot);
  const allowed = buildAllowedSpecifiers(rootReal);
  const packages = readWorkspacePackageManifests(rootReal);
  /** @type {string[]} */
  const allHits = [];

  for (const pkg of packages) {
    const srcDir = join(pkg.dir, 'src');
    let srcReal;
    try {
      srcReal = realpathSync(srcDir);
    } catch {
      continue;
    }
    if (!srcReal.startsWith(rootReal + sep)) {
      throw new Error(`package src escapes repository: ${pkg.relativeDir}`);
    }
    walkSrc(srcReal, rootReal, (file) => {
      const rel = relative(rootReal, file).split(sep).join('/');
      if (statSync(file).size > MAX_SOURCE_BYTES) {
        throw new Error(`source file exceeds 1 MiB: ${rel}`);
      }
      const text = readFileSync(file, 'utf8');
      for (const hit of findUndeclaredImports(rel, text, allowed)) {
        allHits.push(hit);
      }
    });
  }

  allHits.sort();
  return allHits;
}

function main() {
  const hits = verifyWorkspaceImportSurfaces(REPO_ROOT);
  if (hits.length === 0) {
    console.error('[verify-workspace-import-surfaces] ok');
    return;
  }
  console.error('[verify-workspace-import-surfaces] undeclared @opensip-cli imports:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
