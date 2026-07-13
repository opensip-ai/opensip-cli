// @fitness-ignore-file module-coupling-fan-out -- composition root for GraphReadPort: wires generation controller, package/symbol/declaration collaborators, and envelope assembly; high fan-out is the port's job.
// @fitness-ignore-file file-length-limit -- SQLite graph read port aggregates every public query collaborator; length is inherent to the storage-facing facade.
/**
 * SQLite-backed {@link GraphReadPort} (ADR-0084 + MCP Graph Audit Phase 1).
 *
 * Composes {@link GraphGenerationController} for lifecycle and owns query
 * projection + evidence-envelope assembly. Passes the injected datastore only
 * to public graph/read functions — never accesses `.db` or graph persistence.
 */

import { createHash } from 'node:crypto';

import {
  buildImpactTrust,
  ComputeImpactCancelledError,
  TEST_SELECTION_SCHEMA_VERSION,
  type ComputeImpactIndex,
  type ProjectInventorySnapshot,
  type TaskContextSnapshotPointer,
  type TestSelectionSnapshot,
  type VerificationCommand,
} from '@opensip-cli/contracts';
import { err, ok, type LanguageAdapter, type Result } from '@opensip-cli/core';
import {
  buildArchitectureView,
  buildImpactView,
  compareCodePointStrings,
  continuationToken,
  deriveGraphReadFeatures,
  loadCatalogGeneration,
  makeFacet,
  mergeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
  readCatalogIdentity,
  readContextSnapshot,
  selectStaticTests,
  verifyCatalogInputs,
  type Catalog,
  type ContextSnapshotLookup,
  type AuditSourceRolePolicy,
  type FeatureColumn,
  type FeatureTable,
  type GraphAdapterRegistryReader,
  type GraphConfig,
} from '@opensip-cli/graph/read';

import {
  decodeArchitectureCursorState,
  nextArchitectureAfterKey,
} from './architecture-query-page.js';
import {
  generationImpactIndex,
  GraphGenerationController,
  type CatalogGeneration,
} from './catalog-generation.js';
import { deadCodeStableKey, pageDeadCode } from './dead-code-page.js';
import { unavailableGraphStatus } from './freshness.js';
import { blastQueryDigest, projectBlastMembers } from './graph-blast-projection.js';
import {
  digestNormalizedQuery,
  rejectCursorWithoutGeneration,
  validateCursorBinding,
} from './graph-query-page.js';
import { clampLimit } from './graph-read-projection.js';
import { projectTraversal } from './graph-traversal-projection.js';
import { fromGraphReadError, readError } from './mcp-error.js';
import { SqliteGraphDeclarationQueries } from './sqlite-graph-declaration-queries.js';
import { SqliteGraphPackageQueries } from './sqlite-graph-package-queries.js';
import {
  completeInventoryCoverage,
  emptyArchitecture,
  SqliteGraphQueryContext,
} from './sqlite-graph-query-context.js';
import { SqliteGraphSymbolQueries } from './sqlite-graph-symbol-queries.js';

import type {
  ArchitectureQuery,
  ArchitectureSummaryDto,
  BlastDto,
  CatalogStatus,
  ContextPointerStatus,
  ContextPointerStatusOptions,
  DeadCodeQuery,
  DeadCodeResultDto,
  DeclarationSearchDto,
  GraphReadPort,
  ImpactFilesDto,
  ImpactFilesOptions,
  PackageCyclesDto,
  PackageCyclesQuery,
  PackageDependenciesDto,
  PackageDependenciesQuery,
  ReferencesToDto,
  ReferencesToOptions,
  RefreshResult,
  SearchDeclarationsOptions,
  SearchSymbolsOptions,
  SelectTestsOptions,
  MissingGraphTestSelectionDto,
  SymbolSearchDto,
  TraversalQuery,
  TraversalSnapshot,
  WhyDependsDto,
  WhyDependsQuery,
} from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { StaticHandlerBridgeOutcome } from './static-handler-bridge.js';
import type { GraphToolResult, SymbolRef } from './symbol-dto.js';
import type { DataStore } from '@opensip-cli/datastore';

const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_ARCH_LIMIT = 25;
const MAX_CONTEXT_FILES = 128;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_ROWS = 500;
const INVALID_INPUT = 'invalid-input';

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function safeProjectFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    normalized.length <= 1024 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !/\p{Cc}/u.test(normalized) &&
    normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function validateImpactInput(
  files: readonly string[],
  options: ImpactFilesOptions | undefined,
): Result<void, McpReadError> {
  if (files.length === 0) {
    return err(readError(INVALID_INPUT, 'Impact reads require at least one explicit file.'));
  }
  if (files.length > MAX_CONTEXT_FILES) {
    return err(
      readError('input-cap-exceeded', 'Impact file count exceeds the supported maximum.', {
        maximum: MAX_CONTEXT_FILES,
      }),
    );
  }
  const normalized = files.map((file) => file.replaceAll('\\', '/'));
  if (normalized.some((file) => !safeProjectFile(file))) {
    return err(readError(INVALID_INPUT, 'Impact files must be project-relative paths.'));
  }
  if (new Set(normalized).size !== normalized.length) {
    return err(readError(INVALID_INPUT, 'Impact files must be unique after normalization.'));
  }
  if (
    options?.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) ||
      options.maxDepth < 1 ||
      options.maxDepth > MAX_CONTEXT_DEPTH)
  ) {
    return err(readError(INVALID_INPUT, 'Impact depth is outside the supported range.'));
  }
  if (
    options?.top !== undefined &&
    (!Number.isSafeInteger(options.top) || options.top < 1 || options.top > MAX_CONTEXT_ROWS)
  ) {
    return err(readError(INVALID_INPUT, 'Impact top is outside the supported range.'));
  }
  return ok(undefined);
}

function missingImpact(files: readonly string[]): ImpactFilesDto {
  const requestedFiles = [...files].map((file) => file.replaceAll('\\', '/')).sort();
  const coverage = rollupFacets({
    inventory: makeFacet(true, new Set(['graph-catalog-missing'])),
    evidence: UNREQUESTED_FACET,
    grouping: UNREQUESTED_FACET,
    projection: UNREQUESTED_FACET,
  });
  const trust = buildImpactTrust({
    fallback: 'full-run',
    uncertainties: [
      {
        code: 'graph-catalog-unavailable',
        source: 'catalog',
        message: 'No graph catalog is loaded; impact cannot be computed safely.',
      },
    ],
  });
  return {
    changedFunctions: [],
    impactedFunctions: [],
    impactedPackages: [],
    impactedFiles: [],
    requestedFiles,
    matchedFiles: [],
    unmatchedFiles: requestedFiles,
    trust,
    truncated: false,
    coverage,
    nextActions: [
      'Run refresh_graph, then retry impact_files.',
      'Run the full verification suite.',
    ],
  };
}

function impactNextActions(
  impact: Omit<ImpactFilesDto, 'nextActions'>,
  fresh: boolean,
): readonly string[] {
  const actions: string[] = [];
  if (!fresh) actions.push('Run refresh_graph, then retry impact_files.');
  if (impact.trust.fallback === 'full-run') actions.push('Run the full verification suite.');
  else if (impact.unmatchedFiles.length > 0) {
    actions.push('Run package or full verification for unmatched files.');
  }
  return actions;
}

function selectionSnapshotId(snapshot: object): string {
  return `ts1:${createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')}`;
}

function selectionCommandKey(command: VerificationCommand): string {
  return `${command.cwd}\u0000${command.argv.join('\u0000')}`;
}

function fallbackCommands(
  inventory: ProjectInventorySnapshot,
  files: readonly string[],
  tier: NonNullable<SelectTestsOptions['tier']>,
  maximum: number,
): readonly VerificationCommand[] {
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const packageNames = new Set(
    files.flatMap((file) => {
      const name = byPath.get(file)?.packageName;
      return name === undefined ? [] : [name];
    }),
  );
  const allowed = tier === 'full' ? new Set(['full']) : new Set(['package', 'full']);
  const candidates = inventory.packages
    .filter((item) => packageNames.size === 0 || packageNames.has(item.name) || item.root === '.')
    .flatMap((item) => item.verificationCommands)
    .filter((command) => allowed.has(command.tier));
  const unique = new Map<string, VerificationCommand>();
  for (const command of candidates) unique.set(selectionCommandKey(command), command);
  return [...unique.values()]
    .sort((left, right) =>
      compareCodePointStrings(selectionCommandKey(left), selectionCommandKey(right)),
    )
    .slice(0, maximum);
}

function missingSelection(
  files: readonly string[],
  inventory: ProjectInventorySnapshot,
  options: SelectTestsOptions | undefined,
): MissingGraphTestSelectionDto {
  const normalized = files.map((file) => file.replaceAll('\\', '/')).sort();
  const commands = fallbackCommands(
    inventory,
    normalized,
    options?.tier ?? 'focused',
    options?.commandLimit ?? 20,
  );
  const reasonCodes = [
    'graph-catalog-unavailable',
    ...(inventory.coverage.status === 'complete' ? [] : ['inventory-incomplete']),
  ];
  const withoutId: Omit<MissingGraphTestSelectionDto, 'snapshotId'> = {
    schemaVersion: TEST_SELECTION_SCHEMA_VERSION,
    files: normalized,
    tests: [],
    commands,
    uncoveredFiles: normalized,
    trust: {
      status: 'fallback',
      reasonCodes,
      fallbackTier: commands.some((command) => command.tier === 'package') ? 'package' : 'full',
    },
    graphIdentity: 'graph:missing',
    inventoryIdentity: inventory.snapshotId,
    durable: false,
  };
  return { ...withoutId, snapshotId: selectionSnapshotId(withoutId) };
}

function qualifySelection(
  snapshot: TestSelectionSnapshot,
  reasons: readonly string[],
): TestSelectionSnapshot {
  const reasonCodes = [...new Set([...snapshot.trust.reasonCodes, ...reasons])].sort().slice(0, 32);
  if (reasonCodes.length === snapshot.trust.reasonCodes.length) return snapshot;
  const withoutId: Omit<TestSelectionSnapshot, 'snapshotId'> = {
    schemaVersion: snapshot.schemaVersion,
    files: snapshot.files,
    tests: snapshot.tests,
    commands: snapshot.commands,
    uncoveredFiles: snapshot.uncoveredFiles,
    trust: {
      ...snapshot.trust,
      status: snapshot.tests.length === 0 ? 'fallback' : 'partial',
      reasonCodes,
    },
    graphIdentity: snapshot.graphIdentity,
    inventoryIdentity: snapshot.inventoryIdentity,
  };
  return { ...withoutId, snapshotId: selectionSnapshotId(withoutId) };
}

function validateSelectionInput(
  files: readonly string[],
  options: SelectTestsOptions | undefined,
): Result<void, McpReadError> {
  if (files.length === 0) {
    return err(readError(INVALID_INPUT, 'Test selection requires explicit files.'));
  }
  if (files.length > MAX_CONTEXT_FILES) {
    return err(
      readError('input-cap-exceeded', 'Test-selection file count exceeds the maximum.', {
        maximum: MAX_CONTEXT_FILES,
      }),
    );
  }
  const normalized = files.map((file) => file.replaceAll('\\', '/'));
  if (normalized.some((file) => !safeProjectFile(file))) {
    return err(readError(INVALID_INPUT, 'Test-selection files must be project-relative paths.'));
  }
  if (new Set(normalized).size !== normalized.length) {
    return err(readError(INVALID_INPUT, 'Test-selection files must be unique.'));
  }
  if (
    options?.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) ||
      options.maxDepth < 1 ||
      options.maxDepth > MAX_CONTEXT_DEPTH)
  ) {
    return err(readError(INVALID_INPUT, 'Test-selection depth is outside the supported range.'));
  }
  if (
    options?.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_CONTEXT_ROWS)
  ) {
    return err(readError(INVALID_INPUT, 'Test-selection limit is outside the supported range.'));
  }
  if (
    options?.commandLimit !== undefined &&
    (!Number.isSafeInteger(options.commandLimit) ||
      options.commandLimit < 1 ||
      options.commandLimit > 100)
  ) {
    return err(readError(INVALID_INPUT, 'Command limit is outside the supported range.'));
  }
  if (
    options?.proofLimit !== undefined &&
    (!Number.isSafeInteger(options.proofLimit) || options.proofLimit < 0 || options.proofLimit > 6)
  ) {
    return err(readError(INVALID_INPUT, 'Proof limit is outside the supported range.'));
  }
  return ok(undefined);
}

function validContextPointer(pointer: TaskContextSnapshotPointer): boolean {
  return (
    pointer.owner === 'graph' &&
    pointer.id.length > 0 &&
    pointer.id.length <= 256 &&
    pointer.kind.length > 0 &&
    pointer.kind.length <= 128 &&
    Number.isSafeInteger(pointer.schemaVersion) &&
    pointer.schemaVersion >= 1
  );
}

function graphGenerationPointerStatus(
  pointer: TaskContextSnapshotPointer,
  generation: CatalogGeneration | undefined,
): ContextPointerStatus {
  if (generation === undefined) {
    return {
      pointer,
      status: 'missing',
      reasonCodes: ['graph-catalog-missing'],
    };
  }
  const current = generation.key;
  if (current !== pointer.id) {
    return {
      pointer,
      status: 'stale',
      reasonCodes: ['graph-generation-replaced'],
      currentGraphIdentity: current,
    };
  }
  const schemaVersion = Number.parseInt(generation.catalog.version.split('.')[0] ?? '', 10);
  if (schemaVersion !== pointer.schemaVersion) {
    return {
      pointer,
      status: 'unsupported',
      reasonCodes: ['graph-schema-version-unsupported'],
      currentGraphIdentity: current,
    };
  }
  return {
    pointer,
    status: 'available',
    reasonCodes: [],
    currentGraphIdentity: current,
  };
}

function snapshotPointerStatus(
  pointer: TaskContextSnapshotPointer,
  lookup: ContextSnapshotLookup,
): ContextPointerStatus {
  if (lookup.status === 'missing') {
    return {
      pointer,
      status: 'missing',
      reasonCodes: ['context-snapshot-missing'],
    };
  }
  if (lookup.status === 'unsupported-version') {
    return {
      pointer,
      status: 'unsupported',
      reasonCodes: ['context-snapshot-version-unsupported'],
    };
  }
  if (
    lookup.snapshot.kind !== pointer.kind ||
    lookup.snapshot.schemaVersion !== pointer.schemaVersion
  ) {
    return {
      pointer,
      status: 'unsupported',
      reasonCodes: ['context-snapshot-pointer-mismatch'],
    };
  }
  return { pointer, status: 'available', reasonCodes: [] };
}

function selectionProofOptions(options: SelectTestsOptions | undefined): {
  readonly includeProof: boolean;
  readonly maxProofNodes: number | undefined;
} {
  const detail = options?.proofDetail ?? 'summary';
  if (detail === 'none') return { includeProof: false, maxProofNodes: 0 };
  if (detail === 'summary') return { includeProof: true, maxProofNodes: 1 };
  return { includeProof: true, maxProofNodes: options?.proofLimit };
}

function toArchitectureSummaryDto(view: {
  readonly languages: ArchitectureSummaryDto['languages'];
  readonly occurrenceCount: ArchitectureSummaryDto['occurrenceCount'];
  readonly uniqueBodyCount: ArchitectureSummaryDto['uniqueBodyCount'];
  readonly callEvidence: ArchitectureSummaryDto['callEvidence'];
  readonly packageCount: ArchitectureSummaryDto['packageCount'];
  readonly includedSections: ArchitectureSummaryDto['includedSections'];
  readonly packageEdges?: ArchitectureSummaryDto['packageEdges'];
  readonly packageEdgesSummary?: ArchitectureSummaryDto['packageEdgesSummary'];
  readonly hotspots?: ArchitectureSummaryDto['hotspots'];
  readonly hotspotsSummary?: ArchitectureSummaryDto['hotspotsSummary'];
}): ArchitectureSummaryDto {
  return {
    languages: view.languages,
    occurrenceCount: view.occurrenceCount,
    uniqueBodyCount: view.uniqueBodyCount,
    callEvidence: view.callEvidence,
    packageCount: view.packageCount,
    includedSections: view.includedSections,
    ...(view.packageEdges === undefined
      ? {}
      : {
          packageEdges: view.packageEdges,
          ...(view.packageEdgesSummary === undefined
            ? {}
            : { packageEdgesSummary: view.packageEdgesSummary }),
        }),
    ...(view.hotspots === undefined
      ? {}
      : {
          hotspots: view.hotspots,
          ...(view.hotspotsSummary === undefined ? {} : { hotspotsSummary: view.hotspotsSummary }),
        }),
  };
}

/**
 * Resolve the plain audit source-role policy from the validated graph config
 * (P2 Phase 1.4). Returns `{}` (no `sourceRolePolicy` key) when no globs are
 * configured, so the query context echoes nothing and compiles the no-op matcher.
 */
function sourceRolePolicyDep(config: GraphConfig): {
  sourceRolePolicy?: AuditSourceRolePolicy;
} {
  const testGlobs = config.auditTestSourceGlobs ?? [];
  if (testGlobs.length === 0) return {};
  return { sourceRolePolicy: { testGlobs, mode: 'audit-test-globs-v1' } };
}

export interface SqliteGraphReadPortDeps {
  readonly store: DataStore;
  /** Root used for catalog storage/freshness compatibility. */
  readonly projectRoot: string;
  /** Canonical root advertised in response context; defaults to projectRoot. */
  readonly contextProjectRoot?: string;
  readonly configPath?: string;
  readonly adapters: GraphAdapterRegistryReader;
  readonly languageAdapters: readonly LanguageAdapter[];
  readonly rebuild: () => Promise<Result<Catalog, McpReadError>>;
  readonly config?: GraphConfig;
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

export class SqliteGraphReadPort implements GraphReadPort {
  private readonly store: DataStore;
  private readonly controller: GraphGenerationController;
  private readonly queryContext: SqliteGraphQueryContext;
  private readonly packageQueries: SqliteGraphPackageQueries;
  private readonly symbolQueries: SqliteGraphSymbolQueries;
  private readonly declarationQueries: SqliteGraphDeclarationQueries;
  private readonly config: GraphConfig;
  constructor(deps: SqliteGraphReadPortDeps) {
    this.store = deps.store;
    this.config = deps.config ?? {};
    this.controller = new GraphGenerationController({
      store: deps.store,
      projectRoot: deps.projectRoot,
      adapters: deps.adapters,
      readIdentity: (store) => readCatalogIdentity(store),
      loadCatalog: (store) => loadCatalogGeneration(store),
      verify: (input) =>
        verifyCatalogInputs({
          ...input,
          languageAdapters: deps.languageAdapters,
          graphConfig: deps.config ?? {},
        }),
      rebuild: deps.rebuild,
      log: deps.log,
    });
    this.queryContext = new SqliteGraphQueryContext(this.controller, {
      projectRoot: deps.contextProjectRoot ?? deps.projectRoot,
      ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
      ...sourceRolePolicyDep(this.config),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    this.packageQueries = new SqliteGraphPackageQueries({
      context: this.queryContext,
      features: (generation) => this.generationFeatures(generation),
    });
    this.symbolQueries = new SqliteGraphSymbolQueries(this.queryContext, (generation) =>
      this.generationFeatures(generation),
    );
    this.declarationQueries = new SqliteGraphDeclarationQueries(this.queryContext);
  }

  async catalogStatus(): Promise<Result<CatalogStatus, McpReadError>> {
    return this.queryContext.catalogStatus();
  }

  async resolveSymbolId(
    symbolId: string,
  ): Promise<Result<GraphToolResult<SymbolRef | undefined>, McpReadError>> {
    return this.symbolQueries.resolveSymbolId(symbolId);
  }

  async searchSymbols(
    query: string,
    opts?: SearchSymbolsOptions,
  ): Promise<Result<GraphToolResult<SymbolSearchDto>, McpReadError>> {
    return this.symbolQueries.searchSymbols(query, opts);
  }

  async searchDeclarations(
    query: string,
    opts?: SearchDeclarationsOptions,
  ): Promise<Result<GraphToolResult<DeclarationSearchDto>, McpReadError>> {
    return this.declarationQueries.searchDeclarations(query, opts);
  }

  async referencesTo(
    declarationId: string,
    opts?: ReferencesToOptions,
  ): Promise<Result<GraphToolResult<ReferencesToDto>, McpReadError>> {
    return this.declarationQueries.referencesTo(declarationId, opts);
  }

  async resolveStaticHandlerDeclarations(
    runtimeSnapshotKey: string,
    refs: readonly {
      readonly package: string;
      readonly path: string;
      readonly declaration: string;
      readonly admittedPackageIdentity?: string;
      readonly owner?: 'host' | 'tool';
    }[],
  ): Promise<
    Result<
      {
        readonly catalogIdentity?: string;
        readonly catalogStatus: 'loaded' | 'missing' | 'unsupported';
        readonly outcomes: readonly StaticHandlerBridgeOutcome[];
      },
      McpReadError
    >
  > {
    return this.declarationQueries.resolveStaticHandlerDeclarations(runtimeSnapshotKey, refs);
  }

  async findBySpan(
    file: string,
    line: number,
    signal?: AbortSignal,
  ): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> {
    return this.symbolQueries.findBySpan(file, line, signal);
  }

  async symbolAtLocation(
    file: string,
    line: number,
    detail: 'summary' | 'entity',
    signal?: AbortSignal,
  ): ReturnType<GraphReadPort['symbolAtLocation']> {
    return this.symbolQueries.symbolAtLocation(file, line, detail, signal);
  }

  async entityDetail(
    symbolId: string,
    signal?: AbortSignal,
  ): ReturnType<GraphReadPort['entityDetail']> {
    return this.symbolQueries.entityDetail(symbolId, signal);
  }

  async contextPointerStatus(
    pointer: Parameters<GraphReadPort['contextPointerStatus']>[0],
    signal?: AbortSignal,
    options?: ContextPointerStatusOptions,
  ): ReturnType<GraphReadPort['contextPointerStatus']> {
    if (aborted(signal)) {
      return err(readError('cancelled', 'Context pointer read was cancelled.'));
    }
    if (!validContextPointer(pointer)) {
      return err(readError(INVALID_INPUT, 'Context pointer is invalid.'));
    }
    if (pointer.kind === 'graph') {
      const captured = await this.controller.capture();
      if (!captured.ok) return captured;
      if (aborted(signal)) {
        return err(readError('cancelled', 'Context pointer read was cancelled.'));
      }
      const pointerStatus = graphGenerationPointerStatus(pointer, captured.value);
      if (pointerStatus.status !== 'available' || captured.value === undefined) {
        return ok(pointerStatus);
      }
      const freshness = await this.queryContext.freshnessFor(captured.value, options);
      if (!freshness.ok) {
        return ok({
          pointer,
          status: 'stale',
          reasonCodes: ['graph-generation-not-current', 'graph-freshness-verification-failed'],
          currentGraphIdentity: captured.value.key,
        });
      }
      if (!freshness.value.fresh) {
        return ok({
          pointer,
          status: 'stale',
          reasonCodes: [
            'graph-generation-not-current',
            `graph-freshness-${freshness.value.reasonCode ?? freshness.value.verification}`,
          ],
          currentGraphIdentity: captured.value.key,
        });
      }
      return ok(pointerStatus);
    }
    const lookup = readContextSnapshot(this.store, pointer.id);
    if (!lookup.ok) return err(fromGraphReadError(lookup.error));
    if (aborted(signal)) {
      return err(readError('cancelled', 'Context pointer read was cancelled.'));
    }
    return ok(snapshotPointerStatus(pointer, lookup.value));
  }

  async impactFiles(
    files: readonly string[],
    options?: ImpactFilesOptions,
    signal?: AbortSignal,
  ): ReturnType<GraphReadPort['impactFiles']> {
    if (signal?.aborted === true) {
      return err(readError('cancelled', 'Impact read was cancelled.'));
    }
    const checked = validateImpactInput(files, options);
    if (!checked.ok) return checked;
    return this.queryContext.runQuery(
      'impactFiles',
      { identityMode: 'occurrence', sourceScope: 'all' },
      async (gen, freshness) => {
        if (aborted(signal)) {
          return err(readError('cancelled', 'Impact read was cancelled.'));
        }
        if (gen === undefined) {
          const missing = missingImpact(files);
          return this.queryContext.envelope(missing, gen, freshness, {
            coverage: missing.coverage,
          });
        }
        let index: ComputeImpactIndex;
        try {
          index = await generationImpactIndex(gen, signal);
        } catch (error) {
          if (error instanceof ComputeImpactCancelledError) {
            return err(readError('cancelled', 'Impact read was cancelled.'));
          }
          throw error;
        }
        const projected = await buildImpactView(gen.catalog, files, {
          maxDepth: options?.maxDepth,
          top: options?.top,
          index,
          signal,
        });
        if (!projected.ok) return err(fromGraphReadError(projected.error));
        const data: ImpactFilesDto = {
          ...projected.value,
          nextActions: impactNextActions(projected.value, freshness.fresh),
        };
        return this.queryContext.envelope(data, gen, freshness, {
          coverage: projected.value.coverage,
        });
      },
    );
  }

  async selectTests(
    files: readonly string[],
    inventory: ProjectInventorySnapshot,
    options?: SelectTestsOptions,
    signal?: AbortSignal,
  ): ReturnType<GraphReadPort['selectTests']> {
    if (aborted(signal)) {
      return err(readError('cancelled', 'Test selection was cancelled.'));
    }
    const checked = validateSelectionInput(files, options);
    if (!checked.ok) return checked;
    return this.queryContext.runQuery(
      'selectTests',
      { identityMode: 'occurrence', sourceScope: 'all' },
      async (gen, freshness) => {
        if (aborted(signal)) {
          return err(readError('cancelled', 'Test selection was cancelled.'));
        }
        if (gen === undefined) {
          const data = missingSelection(files, inventory, options);
          const coverage = rollupFacets({
            inventory: makeFacet(
              true,
              new Set(
                inventory.coverage.status === 'complete'
                  ? []
                  : ['inventory-incomplete', ...inventory.coverage.reasonCodes],
              ),
            ),
            evidence: makeFacet(true, new Set(['graph-catalog-missing'])),
            grouping: UNREQUESTED_FACET,
            projection: makeFacet(
              true,
              new Set(data.commands.length === 0 ? ['verification-command-unavailable'] : []),
            ),
          });
          return this.queryContext.envelope(data, gen, freshness, { coverage });
        }
        const proof = selectionProofOptions(options);
        const matcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const projected = await selectStaticTests(gen.catalog, gen.indexes, inventory, files, {
          tier: options?.tier,
          graphIdentity: gen.key,
          maxDepth: options?.maxDepth,
          maxCandidates: options?.limit,
          maxCommands: options?.commandLimit,
          includeProof: proof.includeProof,
          maxProofNodes: proof.maxProofNodes,
          sourceRoleMatcher: matcher.value,
          signal,
        });
        if (!projected.ok) return err(fromGraphReadError(projected.error));
        if (aborted(signal)) {
          return err(readError('cancelled', 'Test selection was cancelled.'));
        }
        const inventoryReasons =
          inventory.coverage.status === 'complete'
            ? []
            : ['inventory-incomplete', ...inventory.coverage.reasonCodes];
        const freshnessReasons = freshness.fresh ? [] : ['graph-catalog-stale'];
        const data = qualifySelection(projected.value.snapshot, [
          ...inventoryReasons,
          ...freshnessReasons,
        ]);
        const coverage = rollupFacets({
          inventory: mergeFacet(
            projected.value.coverage.inventory,
            makeFacet(true, new Set(inventoryReasons)),
          ),
          evidence: mergeFacet(
            projected.value.coverage.evidence,
            makeFacet(true, new Set(freshnessReasons)),
          ),
          grouping: projected.value.coverage.grouping,
          projection: projected.value.coverage.projection,
        });
        return this.queryContext.envelope(data, gen, freshness, { coverage });
      },
    );
  }

  async traverse(
    query: TraversalQuery,
  ): Promise<Result<GraphToolResult<TraversalSnapshot>, McpReadError>> {
    const identity = query.identity ?? 'occurrence';
    const filter = this.queryContext.resolveFilter(query.filter, 'discover');
    return this.queryContext.runQuery(
      'traverse',
      { identityMode: identity, sourceScope: filter.sourceScope },
      (gen, freshness) => {
        const matcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!matcher.ok) return matcher;
        const projected = projectTraversal(
          gen,
          query,
          filter,
          this.queryContext.projectKey,
          matcher.value,
        );
        if (!projected.ok) return projected;
        return this.queryContext.envelope(projected.value.data, gen, freshness, {
          ...projected.value.options,
        });
      },
    );
  }

  async blast(
    symbolId: string,
    opts?: Parameters<GraphReadPort['blast']>[1],
  ): Promise<Result<GraphToolResult<BlastDto | undefined>, McpReadError>> {
    const filter = this.queryContext.resolveFilter(opts?.filter, 'discover');
    const detail = opts?.detail ?? 'summary';
    const groupBy = opts?.groupBy ?? 'none';
    const queryDigest = blastQueryDigest(symbolId, filter, groupBy, detail);
    return this.queryContext.runQuery(
      'blast',
      { identityMode: 'body-twin-union', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(opts?.cursor, {
            projectKey: this.queryContext.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const cursor = validateCursorBinding({
          projectKey: this.queryContext.projectKey,
          generationKey: gen.key,
          queryDigest,
          limit: clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT),
          ...(opts?.cursor === undefined ? {} : { cursor: opts.cursor }),
        });
        if (!cursor.ok) return cursor;
        const occ = gen.indexes.byOccId.get(symbolId);
        if (occ === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const score = this.generationFeatures(gen).function.get(occ.bodyHash)?.blast;
        if (score === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, {
            coverage: completeInventoryCoverage(),
          });
        }
        const blastMatcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!blastMatcher.ok) return blastMatcher;
        const projected = projectBlastMembers({
          generation: gen,
          bodyHash: occ.bodyHash,
          symbolId,
          filter,
          matcher: blastMatcher.value,
          options: { ...opts, detail, groupBy },
          projectKey: this.queryContext.projectKey,
        });
        if (!projected.ok) return projected;
        const symbol = projected.value.requested;
        if (symbol === undefined) {
          return this.queryContext.envelope(undefined, gen, freshness, projected.value.options);
        }
        return this.queryContext.envelope(
          {
            symbol,
            members: projected.value.members,
            totalMembership: projected.value.totalMembership,
            ...score,
            identityMode: 'body-twin-union',
            twinCount: projected.value.twinCount,
            detail: projected.value.detail,
            ...(projected.value.filteringLimitations.length === 0
              ? {}
              : { filteringLimitations: projected.value.filteringLimitations }),
          },
          gen,
          freshness,
          projected.value.options,
        );
      },
    );
  }

  private generationFeatures(gen: CatalogGeneration): FeatureTable {
    if (gen.derived.features !== undefined) return gen.derived.features;
    const columns: readonly FeatureColumn[] = ['blast', 'packageCoupling', 'reachableFromEntry'];
    const features = deriveGraphReadFeatures(gen.catalog, gen.indexes, this.config, columns);
    gen.derived.features = features;
    return features;
  }

  async deadCode(
    query?: DeadCodeQuery,
  ): Promise<Result<GraphToolResult<DeadCodeResultDto>, McpReadError>> {
    const limit = clampLimit(query?.limit, DEFAULT_SEARCH_LIMIT);
    const filter = this.queryContext.resolveFilter(query?.filter, 'discover');
    const groupBy = query?.groupBy ?? 'none';
    const detail = query?.detail ?? 'summary';
    const queryDigest = digestNormalizedQuery({
      op: 'deadCode',
      filter,
      groupBy,
      detail,
    });
    return this.queryContext.runQuery(
      'deadCode',
      { identityMode: 'occurrence', sourceScope: filter.sourceScope },
      (gen, freshness) => {
        if (gen === undefined) {
          const cursor = rejectCursorWithoutGeneration(query?.cursor, {
            projectKey: this.queryContext.projectKey,
            queryDigest,
          });
          if (!cursor.ok) return cursor;
          return this.queryContext.envelope(
            {
              detail,
              rows: [],
              totalOrphans: 0,
              reasonCounts: [],
              ruleCounts: [],
            },
            gen,
            freshness,
            {
              coverage: completeInventoryCoverage(),
              page: { limit },
              filter,
            },
          );
        }
        const after = this.queryContext.resolveAfterKey(query?.cursor, {
          projectKey: this.queryContext.projectKey,
          generationKey: gen.key,
          queryDigest,
        });
        if (!after.ok) return after;
        const deadCodeMatcher = this.queryContext.sourceRoleMatcherFor(gen);
        if (!deadCodeMatcher.ok) return deadCodeMatcher;
        const page = pageDeadCode({
          generation: gen,
          config: this.config,
          filter,
          matcher: deadCodeMatcher.value,
          limit,
          afterKey: after.value,
          groupBy,
          detail,
          projectKey: this.queryContext.projectKey,
          queryDigest,
          ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
          cachedFeatures: this.generationFeatures(gen),
        });
        if (!page.ok) return page;
        if (!page.value.anchorFound) {
          return err(readError('cursor-invalid', 'Cursor continuation anchor is invalid.'));
        }
        const last = page.value.data.rows.at(-1);
        const nextCursor =
          page.value.nextCursor ??
          (page.value.hasMore && last !== undefined
            ? this.queryContext.nextCursorFor(
                {
                  projectKey: this.queryContext.projectKey,
                  generationKey: gen.key,
                  queryDigest,
                },
                continuationToken(deadCodeStableKey(last)),
              )
            : undefined);
        return this.queryContext.envelope(page.value.data, gen, freshness, {
          coverage: page.value.coverage,
          page: { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
          filter,
          ...(page.value.groups === undefined ? {} : { groups: page.value.groups }),
        });
      },
    );
  }

  async architectureSummary(
    query?: ArchitectureQuery,
  ): Promise<Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError>> {
    const limit = clampLimit(query?.limit, DEFAULT_ARCH_LIMIT);
    const filter = this.queryContext.resolveFilter(query?.filter, 'production');
    const groupBy = query?.groupBy ?? 'none';
    const sections = query?.sections ?? (['metrics'] as const);
    const topN = query?.topN ?? 20;
    const queryDigest = digestNormalizedQuery({
      op: 'architectureSummary',
      filter,
      groupBy,
      sections,
      topN,
    });
    return this.queryContext.runQuery(
      'architectureSummary',
      { identityMode: 'mixed', sourceScope: filter.sourceScope },
      (gen, freshness) =>
        this.projectArchitectureSummary({
          gen,
          freshness,
          filter,
          limit,
          groupBy,
          sections,
          topN,
          queryDigest,
          cursor: query?.cursor,
        }),
    );
  }

  private projectArchitectureSummary(input: {
    readonly gen: CatalogGeneration | undefined;
    readonly freshness: GraphToolResult<unknown>['freshness'];
    readonly filter: ReturnType<SqliteGraphQueryContext['resolveFilter']>;
    readonly limit: number;
    readonly groupBy: 'none' | 'package' | 'file';
    readonly sections: ArchitectureSummaryDto['includedSections'];
    readonly topN: number;
    readonly queryDigest: string;
    readonly cursor: string | undefined;
  }): Result<GraphToolResult<ArchitectureSummaryDto>, McpReadError> {
    const { gen, freshness, filter, limit, groupBy, sections, topN, queryDigest, cursor } = input;
    if (gen === undefined) {
      const missing = rejectCursorWithoutGeneration(cursor, {
        projectKey: this.queryContext.projectKey,
        queryDigest,
      });
      if (!missing.ok) return missing;
      return ok(
        this.queryContext.envelope(emptyArchitecture(filter, sections), gen, freshness, {
          coverage: completeInventoryCoverage(),
          page: { limit },
          filter,
        }),
      );
    }
    const binding = {
      projectKey: this.queryContext.projectKey,
      generationKey: gen.key,
      queryDigest,
    };
    const after = this.queryContext.resolveAfterKey(cursor, binding);
    if (!after.ok) return after;
    const cursorState = decodeArchitectureCursorState(after.value);
    if (!cursorState.ok) return cursorState;
    const matcher = this.queryContext.sourceRoleMatcherFor(gen);
    if (!matcher.ok) return matcher;
    const view = buildArchitectureView(
      gen.catalog,
      gen.indexes,
      {
        filter,
        limit,
        groupBy,
        sections,
        topN,
        ...(cursorState.value.packageEdgeKey === undefined
          ? {}
          : { afterPackageEdgeKey: cursorState.value.packageEdgeKey }),
        ...(cursorState.value.hotspotKey === undefined
          ? {}
          : { afterHotspotKey: cursorState.value.hotspotKey }),
        packageEdgesDone: cursorState.value.packageEdgesDone,
        hotspotsDone: cursorState.value.hotspotsDone,
      },
      matcher.value,
      this.generationFeatures(gen),
    );
    if (!view.ok) return err(fromGraphReadError(view.error));
    const nextAfterKey = nextArchitectureAfterKey(cursorState.value, view.value);
    const nextCursor =
      nextAfterKey === undefined
        ? undefined
        : this.queryContext.nextCursorFor(binding, nextAfterKey);
    // Architecture view still returns flat coverage reasons; map them onto the
    // inventory facet (groups already contribute group-key-cap there).
    const archCoverage = rollupFacets({
      inventory: makeFacet(true, new Set(view.value.coverage.reasons)),
      evidence: UNREQUESTED_FACET,
      grouping: UNREQUESTED_FACET,
      projection: makeFacet(true, new Set()),
    });
    return ok(
      this.queryContext.envelope(toArchitectureSummaryDto(view.value), gen, freshness, {
        coverage: archCoverage,
        page: { limit, ...(nextCursor === undefined ? {} : { nextCursor }) },
        filter: view.value.effectiveFilter,
        ...(view.value.groups === undefined ? {} : { groups: view.value.groups }),
      }),
    );
  }

  async packageDependencies(
    query: PackageDependenciesQuery,
  ): Promise<Result<GraphToolResult<PackageDependenciesDto>, McpReadError>> {
    return this.packageQueries.packageDependencies(query);
  }

  async whyDepends(
    query: WhyDependsQuery,
  ): Promise<Result<GraphToolResult<WhyDependsDto>, McpReadError>> {
    return this.packageQueries.whyDepends(query);
  }

  async packageCycles(
    query: PackageCyclesQuery,
  ): Promise<Result<GraphToolResult<PackageCyclesDto>, McpReadError>> {
    return this.packageQueries.packageCycles(query);
  }

  async refresh(opts?: {
    forceRebuild?: boolean;
  }): Promise<Result<GraphToolResult<RefreshResult>, McpReadError>> {
    const outcome = await this.controller.refresh(opts?.forceRebuild === true);
    if (!outcome.ok) return outcome;
    const gen = outcome.value.generation;
    const verifiedFreshness = await this.queryContext.freshnessFor(gen);
    if (!verifiedFreshness.ok && outcome.value.action !== 'rebuilt') return verifiedFreshness;
    const freshness = verifiedFreshness.ok
      ? verifiedFreshness.value
      : { ...unavailableGraphStatus(), builtAt: gen.builtAt };
    const data: RefreshResult = {
      generation: {
        builtAt: gen.builtAt,
        identity: gen.key,
        source: gen.source,
      },
      action: outcome.value.action,
      durationMs: outcome.value.durationMs,
      priorGenerationAvailable: outcome.value.priorGenerationAvailable,
    };
    return ok(
      this.queryContext.envelope(data, gen, freshness, {
        coverage: completeInventoryCoverage(),
      }),
    );
  }
}

export { type GraphGeneration } from './graph-read-port.js';
