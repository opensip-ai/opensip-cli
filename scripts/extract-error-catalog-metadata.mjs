#!/usr/bin/env node
/**
 * Extract registered error definitions from known catalog source files.
 * Output: JSON to stdout for build-error-index.mjs.
 *
 * Not a full TS AST walk — catalogs use defineErrorCatalog({...}) with
 * inline object literals. Sufficient for the committed first-party set.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Explicit inventory of package-owned catalog modules (build-time manifest). */
const CATALOG_SOURCES = [
  {
    packageName: '@opensip-cli/core',
    ownerId: 'opensip-cli.core',
    file: 'packages/core/src/lib/error-definition.ts',
    exportName: 'coreSystemErrorCatalog',
  },
  {
    packageName: '@opensip-cli/fitness',
    ownerId: 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224',
    file: 'packages/fitness/engine/src/errors/fitness-error-catalog.ts',
    exportName: 'fitnessErrorCatalog',
  },
  {
    packageName: '@opensip-cli/simulation',
    ownerId: 'simulation',
    file: 'packages/simulation/engine/src/errors/simulation-error-catalog.ts',
    exportName: 'simulationErrorCatalog',
  },
  {
    packageName: '@opensip-cli/external-tool-adapter',
    ownerId: 'external-tool-adapter',
    file: 'packages/external-tool-adapter/src/errors/external-tool-error-catalog.ts',
    exportName: 'externalToolErrorCatalog',
  },
  {
    packageName: '@opensip-cli/mcp',
    ownerId: 'mcp',
    file: 'packages/mcp/src/errors/mcp-error-catalog.ts',
    exportName: 'mcpErrorCatalog',
  },
  {
    // Substrate catalog (Plan 01 ruling D1): a non-Tool package owns codes keyed on its
    // own npm package name, so the index attributes them to codebase rather than the host.
    packageName: '@opensip-cli/codebase',
    ownerId: '@opensip-cli/codebase',
    file: 'packages/codebase/src/errors/codebase-error-catalog.ts',
    exportName: 'codebaseErrorCatalog',
  },
];

const AXES = [
  'source',
  'defaultResponsibility',
  'kind',
  'retry',
  'severity',
  'exposure',
  'exitClass',
  'stability',
  'lifecycle',
  'operatorAction',
];

/**
 * Parse defineErrorCatalog second-argument object literals for code blocks.
 * Heuristic line parser: finds `CODE: {` then property lines until closing `},`.
 */
function extractDefinitions(sourceText, packageName, ownerId, file) {
  const definitions = [];
  const blockRe = /['"]?([A-Z][A-Z0-9_.]+)['"]?\s*:\s*\{([\s\S]*?)\n\s*\},?/gu;
  let match;
  while ((match = blockRe.exec(sourceText)) !== null) {
    const code = match[1];
    const body = match[2];
    if (!body.includes('source:') && !body.includes('operatorAction:')) continue;
    /** @type {Record<string, string>} */
    const fields = { code };
    for (const axis of AXES) {
      const m = new RegExp(`${axis}:\\s*['"]([^'"]+)['"]`, 'u').exec(body);
      if (m) fields[axis] = m[1];
    }
    if (!fields.operatorAction) continue;
    definitions.push({
      code: fields.code,
      packageName,
      ownerId,
      file: relative(REPO_ROOT, file).split('\\').join('/'),
      source: fields.source ?? '',
      defaultResponsibility: fields.defaultResponsibility ?? '',
      kind: fields.kind ?? '',
      retry: fields.retry ?? '',
      severity: fields.severity ?? '',
      exposure: fields.exposure ?? '',
      exitClass: fields.exitClass ?? '',
      stability: fields.stability ?? '',
      lifecycle: fields.lifecycle ?? '',
      operatorAction: fields.operatorAction ?? '',
    });
  }
  return definitions;
}

async function main() {
  const all = [];
  const catalogs = [];
  for (const src of CATALOG_SOURCES) {
    const abs = join(REPO_ROOT, src.file);
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const defs = extractDefinitions(text, src.packageName, src.ownerId, abs);
    catalogs.push({
      packageName: src.packageName,
      ownerId: src.ownerId,
      file: src.file,
      exportName: src.exportName,
      definitionCount: defs.length,
    });
    all.push(...defs);
  }
  all.sort((a, b) => a.code.localeCompare(b.code));
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    catalogCount: catalogs.length,
    definitionCount: all.length,
    catalogs,
    definitions: all,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
