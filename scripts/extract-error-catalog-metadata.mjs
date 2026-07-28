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
    packageName: '@opensip-cli/yagni',
    ownerId: '3aba9195-2297-4f20-99d5-906945092dfc',
    file: 'packages/yagni/engine/src/errors/yagni-error-catalog.ts',
    exportName: 'yagniErrorCatalog',
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
  // Split for the same reason core's is: the host catalog outgrew the file-length bound as a
  // single unit. Each module is listed because this manifest is the repository-wide code
  // uniqueness authority and must see every definition, not just every catalog.
  ...['host-wiring', 'suite-and-runs', 'init-and-policy', 'host-surfaces'].map((domain) => ({
    packageName: 'opensip-cli',
    ownerId: 'opensip-cli',
    file: `packages/cli/src/errors/definitions/${domain}.ts`,
    exportName: 'hostErrorCatalog',
  })),
  {
    packageName: '@opensip-cli/output',
    ownerId: '@opensip-cli/output',
    file: 'packages/output/src/errors/output-error-catalog.ts',
    exportName: 'outputErrorCatalog',
  },
  {
    packageName: '@opensip-cli/config',
    ownerId: '@opensip-cli/config',
    file: 'packages/config/src/errors/config-error-catalog.ts',
    exportName: 'configErrorCatalog',
  },
  {
    packageName: '@opensip-cli/datastore',
    ownerId: '@opensip-cli/datastore',
    file: 'packages/datastore/src/errors/datastore-error-catalog.ts',
    exportName: 'datastoreErrorCatalog',
  },
  {
    packageName: '@opensip-cli/session-store',
    ownerId: '@opensip-cli/session-store',
    file: 'packages/session-store/src/errors/session-store-error-catalog.ts',
    exportName: 'sessionStoreErrorCatalog',
  },
  {
    packageName: '@opensip-cli/graph',
    ownerId: '3873f1c2-02a9-4719-930a-bca74b62b706',
    file: 'packages/graph/engine/src/errors/graph-error-catalog.ts',
    exportName: 'graphErrorCatalog',
  },
  {
    packageName: '@opensip-cli/tree-sitter',
    ownerId: '@opensip-cli/tree-sitter',
    file: 'packages/tree-sitter/src/errors/tree-sitter-error-catalog.ts',
    exportName: 'treeSitterErrorCatalog',
  },
  // Plan 01 Wave 1: `coreErrorCatalog` is assembled from per-domain definition modules
  // (~80 documented definitions exceed this repository's own file-length hard bound in one
  // file). Each module is listed here because the manifest is the repository-wide code
  // uniqueness authority and must see every definition, not just every catalog.
  ...[
    'runtime-coordination',
    'runtime-lease',
    'file-lock',
    'tool-contract',
    'plugin-capability',
    'config-and-runtime',
  ].map((domain) => ({
    packageName: '@opensip-cli/core',
    ownerId: 'opensip-cli.core',
    file: `packages/core/src/lib/errors/definitions/${domain}.ts`,
    exportName: 'coreErrorCatalog',
  })),
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

/** Read every axis literal present in one object-literal body. */
function readAxes(body) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const axis of AXES) {
    const m = new RegExp(`${axis}:\\s*['"]([^'"]+)['"]`, 'u').exec(body);
    if (m) fields[axis] = m[1];
  }
  return fields;
}

/**
 * Collect file-local shared axis bases: `const NAME = { … } as const satisfies …`.
 *
 * Definitions that share a (responsibility x kind) cluster spread a base rather than
 * repeating eight axes, so without resolving the spread this extractor would publish blank
 * axes into `docs/public/70-reference/18-error-code-index.md` — silently, for exactly the
 * definitions that are most consistent.
 *
 * A base may itself spread an earlier base (a narrower cluster refining a broader one), so
 * resolution is transitive within the file. It stays file-local: a base imported from another
 * module is deliberately not followed, because then the index would depend on cross-file
 * resolution this parser cannot verify. Declaration order is the resolution order, which is
 * also what JavaScript requires of a `const` referencing another `const`.
 */
function extractSharedBases(sourceText) {
  /** @type {Record<string, Record<string, string>>} */
  const bases = {};
  const baseRe = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\n\}\s*as const/gu;
  let match;
  while ((match = baseRe.exec(sourceText)) !== null) {
    const body = match[2];
    /** @type {Record<string, string>} */
    const resolved = {};
    for (const parent of [...body.matchAll(/\.\.\.\s*([A-Z][A-Z0-9_]*)\s*,/gu)].map((m) => m[1])) {
      Object.assign(resolved, bases[parent] ?? {});
    }
    Object.assign(resolved, readAxes(body));
    bases[match[1]] = resolved;
  }
  return bases;
}

/**
 * Parse defineErrorCatalog second-argument object literals for code blocks.
 * Heuristic line parser: finds `CODE: {` then property lines until closing `},`.
 */
function extractDefinitions(sourceText, packageName, ownerId, file) {
  const definitions = [];
  const bases = extractSharedBases(sourceText);
  const blockRe = /['"]?([A-Z][A-Z0-9_.]+)['"]?\s*:\s*\{([\s\S]*?)\n\s*\},?/gu;
  let match;
  while ((match = blockRe.exec(sourceText)) !== null) {
    const code = match[1];
    const body = match[2];
    const spreads = [...body.matchAll(/\.\.\.\s*([A-Z][A-Z0-9_]*)\s*,/gu)].map((m) => m[1]);
    if (!body.includes('source:') && !body.includes('operatorAction:') && spreads.length === 0) {
      continue;
    }
    // Spread bases first so an explicit axis in the block body always overrides the base,
    // matching JavaScript's own `{ ...BASE, kind: 'resource' }` semantics.
    /** @type {Record<string, string>} */
    const fields = { code };
    for (const name of spreads) Object.assign(fields, bases[name] ?? {});
    Object.assign(fields, readAxes(body));
    // The definition's own `code:` field WINS over the object key. They are usually the same,
    // but `coreSystemErrorCatalog` keys its terminal entry `UNKNOWN_FAILURE` while the code is
    // `CORE.SYSTEM.UNKNOWN_FAILURE` — so keying on the object property published the wrong code
    // in `docs/public/70-reference/18-error-code-index.md` and made the registration ratchet
    // report a registered code as missing.
    const declared = /\bcode:\s*['"]([A-Z][A-Z0-9_.]+)['"]/u.exec(body);
    fields.code = declared ? declared[1] : code;
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
