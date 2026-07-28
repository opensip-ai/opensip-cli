#!/usr/bin/env node
/**
 * Verify that first-party error catalogs agree across their built objects, source inventory,
 * generated public index, and runtime registration (Plan 01 Phase 6, Task 6.5).
 *
 * Built catalog objects are the truth. Source is deliberately NOT parsed here: the extractor's
 * hand-authored owner labels were the source of the drift this gate is meant to catch.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CATALOG_SOURCES } from './extract-error-catalog-metadata.mjs';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(REPO_ROOT, 'docs/public/70-reference/18-error-code-index.md');

/**
 * The built-object inventory. Adding a source-manifest entry without adding its built object here
 * is itself reported as a missing BUILT plane, so this cannot silently become a second truth.
 */
const BUILT_CATALOG_SPECS = Object.freeze([
  {
    packageName: '@opensip-cli/core',
    exportName: 'coreSystemErrorCatalog',
    expectedOwnerId: 'opensip-cli.core',
  },
  {
    packageName: '@opensip-cli/core',
    exportName: 'coreErrorCatalog',
    expectedOwnerId: 'opensip-cli.core',
  },
  {
    packageName: 'opensip-cli',
    moduleFile: 'packages/cli/dist/errors/host-error-catalog.js',
    exportName: 'hostErrorCatalog',
  },
  { packageName: '@opensip-cli/fitness', tool: true },
  { packageName: '@opensip-cli/simulation', tool: true },
  { packageName: '@opensip-cli/graph', tool: true },
  { packageName: '@opensip-cli/yagni', tool: true },
  { packageName: '@opensip-cli/mcp', tool: true },
  { packageName: '@opensip-cli/codebase', exportName: 'codebaseErrorCatalog' },
  { packageName: '@opensip-cli/config', exportName: 'configErrorCatalog' },
  { packageName: '@opensip-cli/datastore', exportName: 'datastoreErrorCatalog' },
  { packageName: '@opensip-cli/session-store', exportName: 'sessionStoreErrorCatalog' },
  { packageName: '@opensip-cli/tree-sitter', exportName: 'treeSitterErrorCatalog' },
  { packageName: '@opensip-cli/output', exportName: 'outputErrorCatalog' },
  {
    packageName: '@opensip-cli/external-tool-adapter',
    exportName: 'externalToolErrorCatalog',
  },
]);

const pairKey = ({ packageName, ownerId }) => `${packageName}\0${ownerId}`;
export const formatCatalogPair = ({ packageName, ownerId }) => `${packageName} (owner ${ownerId})`;

function isErrorCatalog(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.owner?.id === 'string' &&
    Array.isArray(value.list) &&
    typeof value.get === 'function'
  );
}

function catalogRecord(packageName, catalog) {
  return { packageName, ownerId: catalog.owner.id, catalog };
}

function recordsByPair(records) {
  return new Map(records.map((record) => [pairKey(record), record]));
}

function codeRecords(records) {
  return records.flatMap((record) =>
    (record.catalog?.list ?? []).map((definition) => ({
      code: definition.code,
      packageName: record.packageName,
      ownerId: record.ownerId,
    })),
  );
}

/** Compare catalog identities, naming the missing plane and exact package/owner pair. */
export function findPlaneParityIssues(builtRecords, planeRecords, planeName) {
  const issues = [];
  const built = recordsByPair(builtRecords);
  const plane = recordsByPair(planeRecords);
  for (const [key, record] of built) {
    if (!plane.has(key)) {
      issues.push(`${planeName} missing catalog ${formatCatalogPair(record)}`);
    }
  }
  for (const [key, record] of plane) {
    if (!built.has(key)) {
      issues.push(
        `built objects missing catalog ${formatCatalogPair(record)} (present in ${planeName})`,
      );
    }
  }
  return issues;
}

/** Compare every definition, suppressing per-code noise when the whole catalog is absent. */
export function findCodeParityIssues(
  builtRecords,
  planeRecords,
  planeName,
  planeCatalogRecords = planeRecords,
) {
  const issues = [];
  const builtCatalogs = recordsByPair(builtRecords);
  const planeCatalogs = recordsByPair(planeCatalogRecords);
  const builtCodes = new Map(codeRecords(builtRecords).map((record) => [record.code, record]));
  const planeCodes = new Map();
  for (const record of planeRecords) {
    if (planeCodes.has(record.code))
      issues.push(`${planeName} contains duplicate code ${record.code}`);
    planeCodes.set(record.code, record);
  }

  for (const [code, record] of builtCodes) {
    const actual = planeCodes.get(code);
    if (actual === undefined) {
      if (planeCatalogs.has(pairKey(record))) {
        issues.push(`${planeName} missing code ${code} from ${formatCatalogPair(record)}`);
      }
      continue;
    }
    if (pairKey(actual) !== pairKey(record)) {
      issues.push(
        `${planeName} attributes ${code} to ${formatCatalogPair(actual)}; built object owns ${formatCatalogPair(record)}`,
      );
    }
  }
  for (const [code, record] of planeCodes) {
    if (!builtCodes.has(code) && builtCatalogs.has(pairKey(record))) {
      issues.push(
        `built objects missing code ${code} (present in ${planeName} as ${formatCatalogPair(record)})`,
      );
    }
  }
  return issues;
}

/** Assert head ownership and cross-owner code uniqueness directly against built objects. */
export function findCatalogInvariantIssues(records) {
  const issues = [];
  const headsByOwner = new Map();
  const ownersByHead = new Map();
  const ownersByCode = new Map();

  for (const { catalog } of records) {
    const derivedHeads = new Set(
      catalog.list
        .filter((definition) => definition.code.includes('.'))
        .map((definition) => definition.code.slice(0, definition.code.indexOf('.'))),
    );
    if (derivedHeads.size > 1) {
      issues.push(
        `built catalog owner ${catalog.owner.id} has multiple heads: ${[...derivedHeads].join(', ')}`,
      );
    }
    for (const head of derivedHeads) {
      const ownerHeads = headsByOwner.get(catalog.owner.id) ?? new Set();
      ownerHeads.add(head);
      headsByOwner.set(catalog.owner.id, ownerHeads);
      const headOwners = ownersByHead.get(head) ?? new Set();
      headOwners.add(catalog.owner.id);
      ownersByHead.set(head, headOwners);
    }
    for (const definition of catalog.list) {
      const owners = ownersByCode.get(definition.code) ?? new Set();
      owners.add(definition.owner.id);
      ownersByCode.set(definition.code, owners);
    }
  }

  for (const [owner, heads] of headsByOwner) {
    if (heads.size > 1)
      issues.push(`built owner ${owner} claims multiple heads: ${[...heads].join(', ')}`);
  }
  for (const [head, owners] of ownersByHead) {
    if (owners.size > 1)
      issues.push(`built head ${head} is claimed by multiple owners: ${[...owners].join(', ')}`);
  }
  for (const [code, owners] of ownersByCode) {
    if (owners.size > 1)
      issues.push(`built code ${code} is claimed by multiple owners: ${[...owners].join(', ')}`);
  }
  return issues;
}

function markdownCode(value) {
  return /^`([^`]*)`$/u.exec(value)?.[1];
}

/** Read catalog identities and codes from the generated Markdown plane. */
export function parseGeneratedIndex(markdown) {
  const catalogSection = markdown.split('## Catalogs\n')[1]?.split('\n## Codes\n')[0];
  const codeSection = markdown.split('\n## Codes\n')[1]?.split('\n## See also\n')[0];
  if (catalogSection === undefined || codeSection === undefined) {
    throw new Error('generated index is missing the Catalogs or Codes table');
  }

  const catalogs = [];
  for (const line of catalogSection.split('\n')) {
    const cells = line.startsWith('|')
      ? line
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim())
      : [];
    const packageName = markdownCode(cells[0]);
    const ownerId = markdownCode(cells[1]);
    if (packageName !== undefined && ownerId !== undefined) catalogs.push({ packageName, ownerId });
  }
  const ownerByPackage = new Map(catalogs.map((record) => [record.packageName, record.ownerId]));
  const codes = [];
  for (const line of codeSection.split('\n')) {
    const cells = line.startsWith('|')
      ? line
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim())
      : [];
    const code = markdownCode(cells[0]);
    const packageName = markdownCode(cells[1]);
    if (code === undefined || packageName === undefined) continue;
    const ownerId = ownerByPackage.get(packageName);
    if (ownerId === undefined) throw new Error(`generated index code ${code} has no catalog owner`);
    codes.push({ code, packageName, ownerId });
  }
  return { catalogs, codes };
}

function builtEntryPath(workspacePackage) {
  const entry = workspacePackage.manifest.main;
  if (typeof entry !== 'string' || !entry.startsWith('./')) {
    throw new Error(`${workspacePackage.name} has no relative package.json#main built entry`);
  }
  return join(workspacePackage.dir, entry);
}

async function importFile(file) {
  return import(pathToFileURL(join(REPO_ROOT, file)).href);
}

async function loadBuiltCatalogs(workspaceByName) {
  const records = [];
  const issues = [];
  const modules = new Map();

  for (const spec of BUILT_CATALOG_SPECS) {
    const workspacePackage = workspaceByName.get(spec.packageName);
    const expectedOwnerId =
      spec.expectedOwnerId ??
      (spec.tool === true ? workspacePackage?.manifest.opensipTools?.stableId : spec.packageName);
    if (typeof expectedOwnerId !== 'string') {
      issues.push(`built objects cannot derive the stable owner id for ${spec.packageName}`);
      continue;
    }
    try {
      const cacheKey = spec.moduleFile ?? spec.packageName;
      let module = modules.get(cacheKey);
      if (module === undefined) {
        const url =
          spec.moduleFile === undefined
            ? pathToFileURL(builtEntryPath(workspacePackage)).href
            : pathToFileURL(join(REPO_ROOT, spec.moduleFile)).href;
        module = await import(url);
        modules.set(cacheKey, module);
      }
      const catalog =
        spec.tool === true ? module.tool?.extensionPoints?.errorCatalog : module[spec.exportName];
      if (!isErrorCatalog(catalog)) {
        const surface = spec.tool === true ? 'tool.extensionPoints.errorCatalog' : spec.exportName;
        issues.push(
          `built objects missing catalog ${formatCatalogPair({ packageName: spec.packageName, ownerId: expectedOwnerId })}: ${surface} is not exported by the built package`,
        );
        continue;
      }
      const record = catalogRecord(spec.packageName, catalog);
      records.push(record);
      if (catalog.owner.id !== expectedOwnerId) {
        issues.push(
          `built owner mismatch for ${spec.packageName}: expected ${expectedOwnerId}, received ${catalog.owner.id}`,
        );
      }
      if (catalog.owner.packageName !== spec.packageName) {
        issues.push(
          `built package provenance mismatch for owner ${catalog.owner.id}: expected ${spec.packageName}, received ${catalog.owner.packageName ?? '<missing>'}`,
        );
      }
    } catch (error) {
      issues.push(
        `built objects could not load ${spec.packageName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { records, issues };
}

async function loadRuntimePlane(workspaceByName) {
  const core = await importFile('packages/core/dist/index.js');
  const { resolveDefinitionForCode } = await importFile(
    'packages/core/dist/lib/errors/resolve-definition.js',
  );
  const { HOST_SUBSTRATE_ERROR_CATALOGS } = await importFile(
    'packages/cli/dist/bootstrap/substrate-error-catalogs.js',
  );
  const { BUNDLED_TOOL_PACKAGES } = await importFile(
    'packages/cli/dist/bootstrap/bundled-manifest.js',
  );

  const registry = new core.ToolRegistry();
  for (const contribution of HOST_SUBSTRATE_ERROR_CATALOGS) {
    registry.registerSubstrateCatalog(contribution);
  }
  for (const packageName of BUNDLED_TOOL_PACKAGES) {
    const workspacePackage = workspaceByName.get(packageName);
    const module = await import(pathToFileURL(builtEntryPath(workspacePackage)).href);
    registry.register(module.tool, { sourcePackage: packageName });
  }

  const index = registry.getErrorCatalogIndex();
  const records = [
    catalogRecord('@opensip-cli/core', core.coreSystemErrorCatalog),
    ...HOST_SUBSTRATE_ERROR_CATALOGS.map((entry) =>
      catalogRecord(entry.catalog.owner.packageName, entry.catalog),
    ),
    ...registry
      .list()
      .filter((tool) => isErrorCatalog(tool.extensionPoints?.errorCatalog))
      .map((tool) =>
        catalogRecord(
          tool.extensionPoints.errorCatalog.owner.packageName,
          tool.extensionPoints.errorCatalog,
        ),
      ),
  ];
  const codes = [...index.byCode.values()].map((definition) => ({
    code: definition.code,
    packageName: definition.owner.packageName,
    ownerId: definition.owner.id,
  }));
  const resolutionIssues = [];
  const scope = new core.RunScope({
    tools: registry,
    languages: new core.LanguageRegistry(),
  });
  await core.runWithScope(scope, async () => {
    for (const record of codes) {
      const resolvedDefinition = resolveDefinitionForCode(record.code);
      if (
        resolvedDefinition.code !== record.code ||
        resolvedDefinition.owner.id !== record.ownerId
      ) {
        resolutionIssues.push(
          `runtime resolver demoted ${record.code} from owner ${record.ownerId} to ${resolvedDefinition.code} owned by ${resolvedDefinition.owner.id}`,
        );
      }
    }
  });

  return { records, codes, resolutionIssues };
}

async function main() {
  const workspace = readWorkspacePackageManifests(REPO_ROOT);
  const workspaceByName = new Map(workspace.map((record) => [record.name, record]));
  const { records: built, issues } = await loadBuiltCatalogs(workspaceByName);
  issues.push(...findCatalogInvariantIssues(built));

  const source = CATALOG_SOURCES.map(({ packageName, ownerId }) => ({ packageName, ownerId }));
  const generated = parseGeneratedIndex(await readFile(INDEX_PATH, 'utf8'));
  const runtime = await loadRuntimePlane(workspaceByName);

  issues.push(
    ...findPlaneParityIssues(built, source, 'source inventory'),
    ...findPlaneParityIssues(built, generated.catalogs, 'generated index'),
    ...findPlaneParityIssues(built, runtime.records, 'runtime registration'),
    ...findCodeParityIssues(built, generated.codes, 'generated index', generated.catalogs),
    ...findCodeParityIssues(built, runtime.codes, 'runtime registration', runtime.records),
    ...runtime.resolutionIssues,
  );

  const uniqueIssues = [...new Set(issues)].sort();
  if (uniqueIssues.length > 0) {
    console.error(`catalog-parity: failed with ${uniqueIssues.length} issue(s):`);
    for (const issue of uniqueIssues) console.error(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `catalog-parity: ok (${recordsByPair(built).size} owners, ${codeRecords(built).length} codes)`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `catalog-parity: verifier error — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
