/** Graph-owned context producer services used by the internal agent-context suite. */

import {
  buildProjectInventory,
  projectConfigIdentity,
  type LanguageEvidenceSupport,
} from '@opensip-cli/codebase';
import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
  projectInventorySnapshotSchema,
  type ContextCoverage,
  type FileEvidenceSupport,
  type ProjectInventorySnapshot,
} from '@opensip-cli/contracts';
import {
  EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION,
  readPackageVersion,
  type EvidenceSnapshotContribution,
  type ToolCliContext,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { GRAPH_STABLE_ID } from '../../identity.js';
import {
  buildGraphReadIndexes,
  catalogGenerationKey,
  compileSourceRoleMatcher,
  loadGraphReadConfig,
  MAX_AUDIT_SOURCE_ROLE_FILES,
  rebuildCatalog,
  selectStaticTests,
  verifyCatalogInputs,
} from '../../read/index.js';
import { graphInputFilesIdentity } from '../orchestrate/catalog-build-coverage.js';

import type { Catalog } from '../../types.js';

const GRAPH_VERSION = readPackageVersion(import.meta.url);
const INVENTORY_COMMAND = 'graph-context-inventory';
const GRAPH_ENSURE_COMMAND = 'graph-context-ensure';
const TEST_SELECTION_COMMAND = 'graph-context-select-tests';
const SELECT_TESTS_READ = 'select_tests';
const TEST_SELECTION_KIND = 'test-selection';

export interface ContextInventoryOptions {
  readonly cwd: string;
}

export interface ContextGraphOptions {
  readonly cwd: string;
}

export interface ContextTestSelectionOptions {
  readonly cwd: string;
  readonly files?: readonly string[];
}

type ContextEvidenceKind = 'inventory' | 'graph' | 'test-selection';

function projectRoot(cli: ToolCliContext, fallback: string): string {
  return cli.scope.projectContext?.projectRoot ?? fallback;
}

/** @throws {Error} When the graph tool did not contribute its required RunScope services. */
function graphScope(cli: ToolCliContext): NonNullable<ToolCliContext['scope']['graph']> {
  const scope = cli.scope.graph;
  if (scope === undefined) throw new Error('graph scope unavailable');
  return scope;
}

function producer(command: string): EvidenceSnapshotContribution['producer'] {
  return { toolId: GRAPH_STABLE_ID, command, version: GRAPH_VERSION };
}

function unavailable(
  kind: ContextEvidenceKind,
  command: string,
  status: 'unsupported' | 'failed' | 'cancelled',
  reasonCode: string,
  followUpReads: readonly string[],
): ToolRunCompletion {
  return {
    evidenceSnapshots: [
      {
        schemaVersion: EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION,
        kind,
        producer: producer(command),
        status,
        freshness: { status: 'unknown', reasonCodes: [reasonCode] },
        coverage: {
          status: 'unavailable',
          items: 0,
          reasonCodes: [reasonCode],
        },
        reasons: [{ code: reasonCode }],
        followUpReads,
      },
    ],
  };
}

function completeContribution(input: {
  readonly kind: ContextEvidenceKind;
  readonly command: string;
  readonly snapshotId: string;
  readonly snapshotSchemaVersion: number;
  readonly status: 'rebuilt' | 'reused' | 'partial';
  readonly coverage: 'complete' | 'partial';
  readonly items: number;
  readonly total?: number;
  readonly reasonCodes?: readonly string[];
  readonly followUpReads: readonly string[];
  readonly inputs?: EvidenceSnapshotContribution['inputs'];
}): ToolRunCompletion {
  const reasonCodes = input.reasonCodes ?? [];
  return {
    evidenceSnapshots: [
      {
        schemaVersion: EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION,
        kind: input.kind,
        snapshotId: input.snapshotId,
        snapshotSchemaVersion: input.snapshotSchemaVersion,
        producer: producer(input.command),
        status: input.status,
        freshness: { status: 'current' },
        coverage: {
          status: input.coverage,
          items: input.items,
          ...(input.total === undefined ? {} : { total: input.total }),
          ...(reasonCodes.length === 0 ? {} : { reasonCodes }),
        },
        ...(reasonCodes.length === 0 ? {} : { reasons: reasonCodes.map((code) => ({ code })) }),
        followUpReads: input.followUpReads,
        ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      },
    ],
  };
}

/** Build and durably publish the bounded project inventory plane. */
function registeredEvidenceSupport(cli: ToolCliContext): LanguageEvidenceSupport {
  const support = new Map<string, FileEvidenceSupport>();
  for (const entry of graphScope(cli).adapters.getAll()) {
    const semantic = entry.id === 'typescript' ? 'supported' : 'unsupported';
    support.set(entry.id, {
      callable: 'supported',
      declaration: semantic,
      reference: semantic,
    });
  }
  return support;
}

export async function produceContextInventory(
  opts: ContextInventoryOptions,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const scope = graphScope(cli);
  scope.contextRun.beginInventory();
  try {
    const root = projectRoot(cli, opts.cwd);
    const identity = projectConfigIdentity(cli.scope.configDocument);
    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: identity,
      languageEvidenceSupport: registeredEvidenceSupport(cli),
      ...(cli.scope.targets === undefined ? {} : { targets: cli.scope.targets }),
    });
    const snapshot = inventory.snapshot;
    if (snapshot.coverage.status === 'unavailable') {
      return unavailable(
        'inventory',
        INVENTORY_COMMAND,
        'unsupported',
        snapshot.coverage.reasonCodes[0] ?? 'inventory-unavailable',
        ['get_file_context'],
      );
    }
    const saved = scope.contextSnapshots.save({
      id: snapshot.snapshotId,
      kind: 'inventory',
      schemaVersion: PROJECT_INVENTORY_SCHEMA_VERSION,
      producerVersion: GRAPH_VERSION,
      createdAt: new Date().toISOString(),
      sourceIdentity: snapshot.metadataIdentity,
      configIdentity: identity,
      payload: snapshot,
    });
    scope.contextRun.completeInventory(saved.snapshot.id);
    return completeContribution({
      kind: 'inventory',
      command: INVENTORY_COMMAND,
      snapshotId: saved.snapshot.id,
      snapshotSchemaVersion: saved.snapshot.schemaVersion,
      status: snapshot.coverage.status === 'complete' ? saved.status : 'partial',
      coverage: snapshot.coverage.status,
      items: snapshot.coverage.observed,
      ...(snapshot.coverage.total === undefined ? {} : { total: snapshot.coverage.total }),
      reasonCodes: snapshot.coverage.reasonCodes,
      followUpReads: ['get_file_context'],
    });
  } catch {
    return unavailable('inventory', INVENTORY_COMMAND, 'failed', 'inventory-producer-failed', [
      'get_file_context',
    ]);
  }
}

async function ensuredCatalog(
  opts: ContextGraphOptions,
  cli: ToolCliContext,
): Promise<{ readonly catalog: Catalog; readonly status: 'rebuilt' | 'reused' } | undefined> {
  const root = projectRoot(cli, opts.cwd);
  const scope = graphScope(cli);
  const loadedResult = scope.contextCatalog.load();
  if (!loadedResult.ok) {
    // @swallow-ok: graph context catalog is best-effort; an unreadable catalog degrades to "no context".
    return;
  }
  const loaded = loadedResult.value;
  if (loaded !== null) {
    const verified = await verifyCatalogInputs({
      projectRoot: root,
      catalog: loaded,
      adapters: scope.adapters,
      languageAdapters: cli.scope.languages.list(),
      graphConfig: loadGraphReadConfig(root, cli.scope.projectContext?.configPath),
    });
    if (
      verified.ok &&
      verified.value.verification === 'complete' &&
      verified.value.fresh &&
      loaded.buildCoverage?.status === 'complete'
    ) {
      return { catalog: loaded, status: 'reused' };
    }
  }
  const rebuilt = await rebuildCatalog({ cwd: root });
  if (!rebuilt.ok) {
    // @swallow-ok: graph context is best-effort; a failed rebuild degrades to "no context".
    return;
  }
  const replaced = scope.contextCatalog.replace(rebuilt.value);
  if (!replaced.ok) {
    // @swallow-ok: graph context is best-effort; a failed catalog replace degrades to "no context".
    return;
  }
  return { catalog: rebuilt.value, status: 'rebuilt' };
}

function assessInventoryGraphCoverage(
  catalog: Catalog,
  inventory: ProjectInventorySnapshot,
  reasons: Set<string>,
): void {
  const sourceFiles = inventory.files.filter(
    (file) => file.roles.includes('production') || file.roles.includes('test'),
  );
  const languages = new Set(sourceFiles.flatMap((file) => file.languages));
  if (
    sourceFiles.some(
      (file) => file.languages.length === 0 || file.evidenceSupport.callable === 'unknown',
    )
  ) {
    reasons.add('graph-language-coverage-unverified');
  }
  if ([...languages].some((language) => language !== catalog.language)) {
    reasons.add('graph-language-coverage-partial');
  }
  if (
    sourceFiles.some(
      (file) =>
        file.languages.includes(catalog.language) && file.evidenceSupport.callable !== 'supported',
    )
  ) {
    reasons.add('graph-language-capability-unavailable');
  }
  const build = catalog.buildCoverage;
  if (build === undefined) return;
  const selectedFiles = sourceFiles
    .filter(
      (file) =>
        file.languages.includes(catalog.language) && file.evidenceSupport.callable === 'supported',
    )
    .map((file) => file.path);
  if (
    selectedFiles.length !== build.discoveredFiles ||
    graphInputFilesIdentity(selectedFiles) !== build.filesIdentity
  ) {
    reasons.add('graph-file-coverage-partial');
  }
}

export function assessContextGraphCoverage(input: {
  readonly catalog: Catalog;
  readonly inventory: ProjectInventorySnapshot | undefined;
}): ContextCoverage {
  const reasons = new Set<string>();
  const build = input.catalog.buildCoverage;
  if (build === undefined) reasons.add('graph-build-coverage-unavailable');
  else if (build.status !== 'complete') reasons.add('graph-build-coverage-partial');
  else if (build.parseErrorFiles > 0) reasons.add('graph-parse-errors');
  if (input.catalog.resolutionMode === 'fast') reasons.add('graph-fast-resolution');
  if (input.catalog.adapterSelection?.selectedId !== input.catalog.language) {
    reasons.add('graph-adapter-selection-unverified');
  }
  if (input.inventory?.coverage.status === 'complete') {
    assessInventoryGraphCoverage(input.catalog, input.inventory, reasons);
  } else {
    reasons.add('graph-language-coverage-unverified');
  }
  const total = build?.discoveredFiles;
  const observed =
    build === undefined ? 0 : Math.max(0, build.discoveredFiles - build.parseErrorFiles);
  return {
    status: reasons.size === 0 ? 'complete' : 'partial',
    reasonCodes: [...reasons],
    observed,
    ...(total === undefined ? {} : { total }),
  };
}

/** Ensure one current persisted graph generation, retaining prior data on failure. */
export async function produceContextGraph(
  opts: ContextGraphOptions,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const scope = graphScope(cli);
  scope.contextRun.beginGraph();
  try {
    const ensured = await ensuredCatalog(opts, cli);
    if (ensured === undefined) {
      return unavailable('graph', GRAPH_ENSURE_COMMAND, 'failed', 'graph-ensure-failed', [
        'impact_files',
        'get_symbol',
      ]);
    }
    const identity = catalogGenerationKey({
      language: ensured.catalog.language,
      cacheKey: ensured.catalog.cacheKey,
      filesFingerprint: ensured.catalog.filesFingerprint ?? '',
      builtAt: ensured.catalog.builtAt,
    });
    scope.contextRun.completeGraph(identity);
    const inputs = scope.contextRun.inputs();
    const inventory =
      inputs === undefined ? undefined : inventorySnapshot(cli, inputs.inventorySnapshotId);
    const coverage = assessContextGraphCoverage({
      catalog: ensured.catalog,
      inventory,
    });
    return completeContribution({
      kind: 'graph',
      command: GRAPH_ENSURE_COMMAND,
      snapshotId: identity,
      snapshotSchemaVersion: 3,
      status: coverage.status === 'complete' ? ensured.status : 'partial',
      coverage: coverage.status === 'complete' ? 'complete' : 'partial',
      items: coverage.observed,
      ...(coverage.total === undefined ? {} : { total: coverage.total }),
      reasonCodes: coverage.reasonCodes,
      followUpReads: ['impact_files', 'get_symbol', SELECT_TESTS_READ],
    });
  } catch {
    return unavailable('graph', GRAPH_ENSURE_COMMAND, 'failed', 'graph-ensure-failed', [
      'impact_files',
      'get_symbol',
    ]);
  }
}

function inventorySnapshot(
  cli: ToolCliContext,
  snapshotId: string,
): ProjectInventorySnapshot | undefined {
  const record = graphScope(cli).contextSnapshots.get(snapshotId);
  if (record?.schemaVersion !== PROJECT_INVENTORY_SCHEMA_VERSION) return;
  const parsed = projectInventorySnapshotSchema.safeParse(record.payload);
  return parsed.success ? parsed.data : undefined;
}

function* catalogFilePaths(catalog: Catalog): Generator<string> {
  for (const name in catalog.functions) {
    if (!Object.hasOwn(catalog.functions, name)) continue;
    for (const occurrence of catalog.functions[name] ?? []) yield occurrence.filePath;
  }
}

/** Select and durably publish static tests for explicit files only. */
export async function produceContextTestSelection(
  opts: ContextTestSelectionOptions,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const files = opts.files ?? [];
  if (files.length === 0) {
    return unavailable(
      TEST_SELECTION_KIND,
      TEST_SELECTION_COMMAND,
      'unsupported',
      'test-selection-files-not-provided',
      [SELECT_TESTS_READ],
    );
  }
  try {
    const scope = graphScope(cli);
    const inputs = scope.contextRun.inputs();
    if (inputs === undefined) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-prior-evidence-missing',
        ['get_context_status', SELECT_TESTS_READ],
      );
    }
    const inventory = inventorySnapshot(cli, inputs.inventorySnapshotId);
    if (inventory === undefined) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-inventory-binding-mismatch',
        ['get_file_context', SELECT_TESTS_READ],
      );
    }
    const loadedResult = scope.contextCatalog.load();
    if (!loadedResult.ok) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-graph-read-failed',
        ['impact_files', SELECT_TESTS_READ],
      );
    }
    const loaded = loadedResult.value;
    if (loaded === null) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-graph-missing',
        ['impact_files', SELECT_TESTS_READ],
      );
    }
    const graphIdentity = catalogGenerationKey({
      language: loaded.language,
      cacheKey: loaded.cacheKey,
      filesFingerprint: loaded.filesFingerprint ?? '',
      builtAt: loaded.builtAt,
    });
    if (graphIdentity !== inputs.graphSnapshotId) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-graph-binding-mismatch',
        ['get_context_status', 'impact_files', SELECT_TESTS_READ],
      );
    }
    const graphConfig = loadGraphReadConfig(
      projectRoot(cli, opts.cwd),
      cli.scope.projectContext?.configPath,
    );
    const testGlobs = graphConfig.auditTestSourceGlobs ?? [];
    const sourceRoles = compileSourceRoleMatcher(
      testGlobs.length === 0 ? undefined : { testGlobs, mode: 'audit-test-globs-v1' },
      catalogFilePaths(loaded),
      { maxFiles: MAX_AUDIT_SOURCE_ROLE_FILES },
    );
    if (!sourceRoles.ok) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-source-role-unavailable',
        [SELECT_TESTS_READ],
      );
    }
    const selected = await selectStaticTests(
      loaded,
      buildGraphReadIndexes(loaded),
      inventory,
      files,
      { graphIdentity, sourceRoleMatcher: sourceRoles.value },
    );
    if (!selected.ok) {
      return unavailable(
        TEST_SELECTION_KIND,
        TEST_SELECTION_COMMAND,
        'failed',
        'test-selection-failed',
        [SELECT_TESTS_READ],
      );
    }
    const snapshot = selected.value.snapshot;
    const saved = scope.contextSnapshots.save({
      id: snapshot.snapshotId,
      kind: TEST_SELECTION_KIND,
      schemaVersion: TEST_SELECTION_SCHEMA_VERSION,
      producerVersion: GRAPH_VERSION,
      createdAt: new Date().toISOString(),
      sourceIdentity: `${snapshot.graphIdentity}:${snapshot.inventoryIdentity}`,
      configIdentity: inventory.project.configIdentity,
      payload: snapshot,
    });
    scope.contextRun.completeTestSelection(saved.snapshot.id);
    const complete = snapshot.trust.status === 'complete';
    return completeContribution({
      kind: TEST_SELECTION_KIND,
      command: TEST_SELECTION_COMMAND,
      snapshotId: saved.snapshot.id,
      snapshotSchemaVersion: saved.snapshot.schemaVersion,
      status: complete ? saved.status : 'partial',
      coverage: complete ? 'complete' : 'partial',
      items: snapshot.tests.length,
      reasonCodes: snapshot.trust.reasonCodes,
      followUpReads: [SELECT_TESTS_READ],
      inputs: [
        { kind: 'inventory', snapshotId: inputs.inventorySnapshotId },
        { kind: 'graph', snapshotId: inputs.graphSnapshotId },
      ],
    });
  } catch {
    return unavailable(
      TEST_SELECTION_KIND,
      TEST_SELECTION_COMMAND,
      'failed',
      'test-selection-producer-failed',
      [SELECT_TESTS_READ],
    );
  }
}
