/** Explainable static test selection over one graph generation + inventory snapshot. */

import { posix } from 'node:path';

import { buildTestSelectionSnapshotIdentity } from '@opensip-cli/contracts';
import { err, ok, type Result } from '@opensip-cli/core';

import { compareCodePointStrings } from '../code-point-order.js';

import { makeFacet, rollupFacets, UNREQUESTED_FACET } from './bounded-view.js';
import { catalogGenerationKey } from './catalog-generation-key.js';
import { GRAPH_SYMBOL_NAME_MAX, toGraphSymbolRef } from './query-contracts.js';

import type { GraphReadFacetCoverage } from './query-contracts.js';
import type { SourceRoleMatcher } from './source-filter.js';
import type { Catalog, GraphReadError, Indexes } from './types.js';
import type { FunctionOccurrence } from '../types.js';
import type {
  FileFact,
  ProjectInventorySnapshot,
  SelectedTest,
  TestSelectionBasis,
  TestSelectionSnapshot,
  VerificationCommand,
} from '@opensip-cli/contracts';

export const MAX_TEST_SELECTION_FILES = 128;
export const MAX_TEST_SELECTION_DEPTH = 5;
export const MAX_TEST_SELECTION_CANDIDATES = 500;
export const MAX_TEST_SELECTION_COMMANDS = 100;
export const MAX_TEST_SELECTION_PROOF_NODES = 6;
export const MAX_TEST_SELECTION_VISITED_NODES = 20_000;
export const MAX_TEST_SELECTION_VISITED_EDGES = 100_000;
const ASYNC_BATCH_SIZE = 512;
const MALFORMED_EVIDENCE_REASON = 'test-selection-malformed-evidence-omitted';
const GRAPH_IDENTITY_PATTERN = /^g1:[a-f0-9]{64}$/u;

// @sequential-ok — awaited loops in this module are cooperative-yield scans
// over shared, hard-capped maps/queues/counters. Concurrency would race early
// cap termination and change deterministic evidence, proof, and candidate order.

class TestSelectionCancelledError extends Error {
  constructor() {
    super('Static test selection was cancelled.');
    this.name = 'TestSelectionCancelledError';
  }
}

/**
 * Stop bounded selection work at cooperative cancellation checkpoints.
 *
 * @throws {TestSelectionCancelledError} When the caller's signal is aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new TestSelectionCancelledError();
}

async function yieldToEventLoop(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

type Confidence = SelectedTest['confidence'];

/** Bounded selection policy, graph binding, source-role, and cancellation controls. */
export interface StaticTestSelectionOptions {
  readonly tier?: 'focused' | 'package' | 'full';
  readonly graphIdentity?: string;
  readonly maxDepth?: number;
  readonly maxCandidates?: number;
  readonly maxCommands?: number;
  readonly maxProofNodes?: number;
  readonly includeProof?: boolean;
  /** Config-resolved test-source classification for this catalog generation. */
  readonly sourceRoleMatcher?: SourceRoleMatcher;
  readonly signal?: AbortSignal;
}

/** Immutable selection snapshot plus faceted coverage and compact degradation reasons. */
export interface StaticTestSelectionView {
  readonly snapshot: TestSelectionSnapshot;
  readonly coverage: GraphReadFacetCoverage;
  readonly reasonCodes: readonly string[];
}

interface ReverseEvidence {
  readonly fromHash: string;
  /** Stable caller occurrence identity; body twins remain distinct. */
  readonly fromOccurrence: string;
  readonly basis: 'call' | 'import';
  readonly confidence: Confidence;
  readonly proof: string;
}

interface QueueEntry {
  readonly hash: string;
  readonly occurrenceKey: string;
  readonly depth: number;
  readonly confidence: Confidence;
  readonly basis: 'call' | 'import';
  readonly proof: readonly string[];
  readonly sourceFile: string;
}

interface Candidate {
  readonly selected: SelectedTest;
  readonly sourceFiles: Set<string>;
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  exact: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function selectionError(code: string, message: string): GraphReadError {
  return { code, operation: 'analysis', message };
}

function safeProjectPath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    /\p{Cc}/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    ? normalized
    : undefined;
}

function normalizeFiles(files: readonly string[]): Result<readonly string[], GraphReadError> {
  if (files.length === 0 || files.length > MAX_TEST_SELECTION_FILES) {
    return err(
      selectionError(
        'GRAPH.READ.TEST_SELECTION_FILES_CAP',
        `Test selection requires 1-${String(MAX_TEST_SELECTION_FILES)} project-relative files`,
      ),
    );
  }
  const normalized = new Set<string>();
  for (const file of files) {
    const candidate = safeProjectPath(file);
    if (candidate === undefined) {
      return err(
        selectionError(
          'GRAPH.READ.TEST_SELECTION_FILE_INVALID',
          'Test selection files must be bounded project-relative POSIX paths',
        ),
      );
    }
    normalized.add(candidate);
  }
  return ok([...normalized].sort(compareCodePointStrings));
}

function weakest(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[left] >= CONFIDENCE_RANK[right] ? left : right;
}

function safeEvidenceScalar(value: string): string | undefined {
  return value.length > 0 && value.length <= 1024 && !/\p{Cc}/u.test(value) ? value : undefined;
}

function occurrenceId(occurrence: FunctionOccurrence): string | undefined {
  return toGraphSymbolRef(occurrence)?.symbolId;
}

function boundedProof(
  values: readonly string[],
  maxProofNodes: number,
  reasons?: Set<string>,
): readonly string[] {
  const result: string[] = [];
  for (const value of values) {
    const safe = safeEvidenceScalar(value);
    if (safe === undefined) {
      reasons?.add(MALFORMED_EVIDENCE_REASON);
      continue;
    }
    if (result.length >= maxProofNodes) break;
    result.push(safe);
  }
  return result;
}

function addReverse(
  reverse: Map<string, ReverseEvidence[]>,
  seen: Map<string, Set<string>>,
  targetHash: string,
  evidence: ReverseEvidence,
): void {
  const rows = reverse.get(targetHash) ?? [];
  const keys = seen.get(targetHash) ?? new Set<string>();
  const key = `${evidence.fromHash}\u0000${evidence.fromOccurrence}\u0000${evidence.basis}\u0000${evidence.proof}`;
  if (!keys.has(key)) {
    keys.add(key);
    seen.set(targetHash, keys);
    rows.push(evidence);
    reverse.set(targetHash, rows);
  }
}

interface ReverseBuildState {
  edges: number;
  work: number;
  capped: boolean;
  malformedEvidence: boolean;
}

interface OccurrenceEvidenceSite {
  readonly targets: readonly unknown[];
  readonly basis: ReverseEvidence['basis'];
  readonly confidence: Confidence;
  readonly line: number;
  readonly column: number;
}

interface ReverseEvidenceTargetContext {
  readonly reverse: Map<string, ReverseEvidence[]>;
  readonly seen: Map<string, Set<string>>;
  readonly occurrence: FunctionOccurrence;
  readonly fromOccurrence: string;
  readonly state: ReverseBuildState;
  readonly signal?: AbortSignal;
}

function isEvidenceCoordinate(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= minimum;
}

function isCallConfidence(value: unknown): value is Exclude<Confidence, 'exact'> {
  return value === 'high' || value === 'medium' || value === 'low';
}

function evidenceSite(
  raw: unknown,
  basis: ReverseEvidence['basis'],
  confidence: Confidence | undefined,
  state: ReverseBuildState,
): OccurrenceEvidenceSite | undefined {
  if (typeof raw !== 'object' || raw === null) {
    state.malformedEvidence = true;
    return;
  }
  const value = raw as Record<string, unknown>;
  if (
    !Array.isArray(value.to) ||
    !isEvidenceCoordinate(value.line, 1) ||
    !isEvidenceCoordinate(value.column, 0) ||
    confidence === undefined
  ) {
    state.malformedEvidence = true;
    return;
  }
  return {
    targets: value.to,
    basis,
    confidence,
    line: value.line,
    column: value.column,
  };
}

async function advanceReverseWork(
  state: ReverseBuildState,
  signal: AbortSignal | undefined,
): Promise<void> {
  state.work++;
  if (state.work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
}

async function addEvidenceTarget(
  context: ReverseEvidenceTargetContext,
  site: OccurrenceEvidenceSite,
  targetHash: unknown,
): Promise<boolean> {
  throwIfAborted(context.signal);
  if (context.state.edges >= MAX_TEST_SELECTION_VISITED_EDGES) {
    context.state.capped = true;
    return false;
  }
  context.state.edges++;
  const proof = safeEvidenceScalar(
    `${context.occurrence.filePath.replaceAll('\\', '/')}:${String(site.line)}:${String(site.column)}`,
  );
  const safeTargetHash =
    typeof targetHash === 'string' && targetHash.length <= GRAPH_SYMBOL_NAME_MAX
      ? safeEvidenceScalar(targetHash)
      : undefined;
  if (proof === undefined || safeTargetHash === undefined) {
    context.state.malformedEvidence = true;
  } else {
    addReverse(context.reverse, context.seen, safeTargetHash, {
      fromHash: context.occurrence.bodyHash,
      fromOccurrence: context.fromOccurrence,
      basis: site.basis,
      confidence: site.confidence,
      proof,
    });
  }
  await advanceReverseWork(context.state, context.signal);
  return true;
}

interface OccurrenceEvidenceInput {
  readonly reverse: Map<string, ReverseEvidence[]>;
  readonly seen: Map<string, Set<string>>;
  readonly occurrence: FunctionOccurrence;
  readonly sites: Iterable<OccurrenceEvidenceSite>;
  readonly state: ReverseBuildState;
  readonly signal: AbortSignal | undefined;
}

async function addOccurrenceEvidence(input: OccurrenceEvidenceInput): Promise<boolean> {
  const { reverse, seen, occurrence, sites, state, signal } = input;
  const fromOccurrence = occurrenceId(occurrence);
  if (fromOccurrence === undefined) {
    state.malformedEvidence = true;
    return true;
  }
  const context: ReverseEvidenceTargetContext = {
    reverse,
    seen,
    occurrence,
    fromOccurrence,
    state,
    signal,
  };
  for (const site of sites) {
    for (const targetHash of site.targets) {
      if (!(await addEvidenceTarget(context, site, targetHash))) {
        return false;
      }
    }
  }
  return true;
}

function* callEvidenceSites(
  occurrence: FunctionOccurrence,
  state: ReverseBuildState,
): Generator<OccurrenceEvidenceSite> {
  const calls: unknown = occurrence.calls;
  if (!Array.isArray(calls)) {
    state.malformedEvidence = true;
    return;
  }
  for (const call of calls) {
    const confidence =
      typeof call === 'object' && call !== null
        ? (call as Record<string, unknown>).confidence
        : undefined;
    const site = evidenceSite(
      call,
      'call',
      isCallConfidence(confidence) ? confidence : undefined,
      state,
    );
    if (site !== undefined) yield site;
  }
}

interface OccurrenceEvidenceScanInput {
  readonly reverse: Map<string, ReverseEvidence[]>;
  readonly seen: Map<string, Set<string>>;
  readonly occurrence: FunctionOccurrence;
  readonly state: ReverseBuildState;
  readonly signal: AbortSignal | undefined;
}

function addOccurrenceCallEvidence(input: OccurrenceEvidenceScanInput): Promise<boolean> {
  return addOccurrenceEvidence({
    ...input,
    sites: callEvidenceSites(input.occurrence, input.state),
  });
}

function dependencyConfidence(
  dependency: NonNullable<FunctionOccurrence['dependencies']>[number],
): Confidence {
  return dependency.classification?.targetKind === 'catalog-source' ? 'high' : 'medium';
}

function* dependencyEvidenceSites(
  occurrence: FunctionOccurrence,
  state: ReverseBuildState,
): Generator<OccurrenceEvidenceSite> {
  const dependencies: unknown = occurrence.dependencies;
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    state.malformedEvidence = true;
    return;
  }
  for (const dependency of dependencies ?? []) {
    const site = evidenceSite(
      dependency,
      'import',
      typeof dependency === 'object' && dependency !== null
        ? dependencyConfidence(
            dependency as NonNullable<FunctionOccurrence['dependencies']>[number],
          )
        : undefined,
      state,
    );
    if (site !== undefined) yield site;
  }
}

function addOccurrenceDependencyEvidence(input: OccurrenceEvidenceScanInput): Promise<boolean> {
  return addOccurrenceEvidence({
    ...input,
    sites: dependencyEvidenceSites(input.occurrence, input.state),
  });
}

function compareReverseEvidence(left: ReverseEvidence, right: ReverseEvidence): number {
  const byHash = compareCodePointStrings(left.fromHash, right.fromHash);
  if (byHash !== 0) return byHash;
  const byOccurrence = compareCodePointStrings(left.fromOccurrence, right.fromOccurrence);
  if (byOccurrence !== 0) return byOccurrence;
  return compareCodePointStrings(left.proof, right.proof);
}

async function mergeSortedEvidence(
  left: readonly ReverseEvidence[],
  right: readonly ReverseEvidence[],
  work: { value: number },
  signal: AbortSignal | undefined,
): Promise<ReverseEvidence[]> {
  const merged: ReverseEvidence[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    throwIfAborted(signal);
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (
      rightValue === undefined ||
      (leftValue !== undefined && compareReverseEvidence(leftValue, rightValue) <= 0)
    ) {
      if (leftValue !== undefined) merged.push(leftValue);
      leftIndex++;
    } else {
      merged.push(rightValue);
      rightIndex++;
    }
    work.value++;
    if (work.value % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  return merged;
}

async function sortEvidenceRows(
  rows: readonly ReverseEvidence[],
  work: { value: number },
  signal: AbortSignal | undefined,
): Promise<ReverseEvidence[]> {
  if (rows.length <= 1) return [...rows];
  let runs: ReverseEvidence[][] = [];
  for (let offset = 0; offset < rows.length; offset += ASYNC_BATCH_SIZE) {
    throwIfAborted(signal);
    const run = rows.slice(offset, offset + ASYNC_BATCH_SIZE).sort(compareReverseEvidence);
    runs.push(run);
    work.value += run.length;
    if (work.value >= ASYNC_BATCH_SIZE) {
      work.value = 0;
      await yieldToEventLoop(signal);
    }
  }
  while (runs.length > 1) {
    const next: ReverseEvidence[][] = [];
    for (let index = 0; index < runs.length; index += 2) {
      const left = runs[index] ?? [];
      const right = runs[index + 1];
      next.push(right === undefined ? left : await mergeSortedEvidence(left, right, work, signal));
    }
    runs = next;
  }
  return runs[0] ?? [];
}

async function scanReverseEvidence(
  catalog: Catalog,
  reverse: Map<string, ReverseEvidence[]>,
  seen: Map<string, Set<string>>,
  state: ReverseBuildState,
  signal: AbortSignal | undefined,
): Promise<{
  readonly reverse: Map<string, ReverseEvidence[]>;
  readonly complete: boolean;
}> {
  for (const name in catalog.functions) {
    if (!Object.hasOwn(catalog.functions, name)) continue;
    const occurrences = catalog.functions[name] ?? [];
    for (const occurrence of occurrences) {
      throwIfAborted(signal);
      const scan: OccurrenceEvidenceScanInput = {
        reverse,
        seen,
        occurrence,
        state,
        signal,
      };
      // @fitness-ignore-next-line async-waterfall-detection -- Call edges must consume the shared deterministic edge cap before dependency edges for this occurrence.
      const callsComplete = await addOccurrenceCallEvidence(scan);
      if (!callsComplete) return { reverse, complete: false };
      const dependenciesComplete = await addOccurrenceDependencyEvidence(scan);
      if (!dependenciesComplete) return { reverse, complete: false };
      await advanceReverseWork(state, signal);
    }
  }
  return { reverse, complete: true };
}

async function sortReverseEvidence(
  reverse: Map<string, ReverseEvidence[]>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sortWork = { value: 0 };
  for (const [targetHash, rows] of reverse) {
    throwIfAborted(signal);
    reverse.set(targetHash, await sortEvidenceRows(rows, sortWork, signal));
    sortWork.value++;
    if (sortWork.value >= ASYNC_BATCH_SIZE) {
      sortWork.value = 0;
      await yieldToEventLoop(signal);
    }
  }
}

async function buildReverseEvidence(
  catalog: Catalog,
  signal: AbortSignal | undefined,
): Promise<{
  readonly reverse: ReadonlyMap<string, readonly ReverseEvidence[]>;
  readonly capped: boolean;
  readonly malformedEvidence: boolean;
}> {
  const reverse = new Map<string, ReverseEvidence[]>();
  const seen = new Map<string, Set<string>>();
  const state: ReverseBuildState = {
    edges: 0,
    work: 0,
    capped: false,
    malformedEvidence: false,
  };
  const scan = await scanReverseEvidence(catalog, reverse, seen, state, signal);
  await sortReverseEvidence(scan.reverse, signal);
  return {
    reverse: scan.reverse,
    capped: state.capped,
    malformedEvidence: state.malformedEvidence,
  };
}

function isTestOccurrence(
  occurrence: FunctionOccurrence,
  fileByPath: ReadonlyMap<string, FileFact>,
  sourceRoleMatcher: SourceRoleMatcher | undefined,
): boolean {
  const filePath = safeProjectPath(occurrence.filePath);
  if (filePath === undefined) return false;
  return (
    occurrence.inTestFile === true ||
    sourceRoleMatcher?.matches(filePath) === true ||
    fileByPath.get(filePath)?.roles.includes('test') === true
  );
}

function basisFor(entry: QueueEntry): TestSelectionBasis {
  if (entry.basis === 'import') return 'module-import';
  return entry.depth <= 1 ? 'direct-call' : 'transitive-call';
}

interface AddCandidateInput {
  readonly candidates: Map<string, Candidate>;
  readonly occurrence: FunctionOccurrence;
  readonly entry: QueueEntry;
  readonly maxCandidates: number;
  readonly reasons: Set<string>;
  readonly maxProofNodes: number;
}

function addCandidate(input: AddCandidateInput): void {
  const { occurrence, entry, maxCandidates, reasons, maxProofNodes } = input;
  const path = safeProjectPath(occurrence.filePath);
  const identity = occurrenceId(occurrence);
  if (path === undefined || identity === undefined) {
    reasons.add(MALFORMED_EVIDENCE_REASON);
    return;
  }
  const selected: SelectedTest = {
    path,
    basis: basisFor(entry),
    confidence: entry.confidence,
    proof: boundedProof([...entry.proof, identity], maxProofNodes, reasons),
    observed: false,
  };
  const existing = input.candidates.get(selected.path);
  if (existing !== undefined) {
    existing.sourceFiles.add(entry.sourceFile);
    if (compareSelected(selected, existing.selected) < 0) {
      input.candidates.set(selected.path, {
        selected,
        sourceFiles: existing.sourceFiles,
      });
    }
    return;
  }
  if (input.candidates.size >= maxCandidates) {
    reasons.add('test-selection-candidate-cap');
    return;
  }
  input.candidates.set(selected.path, {
    selected,
    sourceFiles: new Set([entry.sourceFile]),
  });
}

function compareSelected(left: SelectedTest, right: SelectedTest): number {
  const confidence = CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence];
  if (confidence !== 0) return confidence;
  const basis = compareCodePointStrings(left.basis, right.basis);
  if (basis !== 0) return basis;
  return compareCodePointStrings(left.path, right.path);
}

function coLocated(changedFile: string, testFile: string): boolean {
  const changedBase = posix.basename(changedFile).replace(/\.[^.]+$/u, '');
  const testBase = posix.basename(testFile);
  return (
    testBase.startsWith(`${changedBase}.test.`) ||
    testBase.startsWith(`${changedBase}.spec.`) ||
    testBase === `test_${changedBase}.py` ||
    testBase === `${changedBase}_test.py` ||
    (testFile.includes('/__tests__/') && testBase.startsWith(`${changedBase}.`))
  );
}

function conventionBasis(
  changedFile: string,
  changed: FileFact | undefined,
  test: FileFact,
): 'co-located' | 'target-convention' | undefined {
  const conventionBacked = test.provenance.some(
    (item) => item.source === 'convention' || item.source === 'target',
  );
  if (!conventionBacked) return;
  if (coLocated(changedFile, test.path)) return 'co-located';
  if (changed?.targets.some((target) => test.targets.includes(target)) === true) {
    return 'target-convention';
  }
}

interface ConventionCandidateInput {
  readonly changedFile: string;
  readonly changed: FileFact | undefined;
  readonly test: FileFact;
  readonly candidates: Map<string, Candidate>;
  readonly maxCandidates: number;
  readonly reasons: Set<string>;
  readonly maxProofNodes: number;
}

function addConventionCandidate(input: ConventionCandidateInput): boolean {
  const { changedFile, changed, test, maxCandidates, reasons, maxProofNodes } = input;
  const basis = conventionBasis(changedFile, changed, test);
  if (basis === undefined) return true;
  const safeTestPath = safeProjectPath(test.path);
  if (safeTestPath === undefined) {
    reasons.add(MALFORMED_EVIDENCE_REASON);
    return true;
  }
  const existing = input.candidates.get(safeTestPath);
  if (existing !== undefined) {
    existing.sourceFiles.add(changedFile);
    return true;
  }
  if (input.candidates.size >= maxCandidates) {
    reasons.add('test-selection-candidate-cap');
    return false;
  }
  input.candidates.set(safeTestPath, {
    selected: {
      path: safeTestPath,
      basis,
      confidence: basis === 'co-located' ? 'medium' : 'low',
      proof: boundedProof([changedFile, safeTestPath], maxProofNodes, reasons),
      observed: false,
    },
    sourceFiles: new Set([changedFile]),
  });
  return true;
}

interface ConventionCandidateContext {
  readonly inventory: ProjectInventorySnapshot;
  readonly candidates: Map<string, Candidate>;
  readonly limits: Pick<SelectionLimits, 'maxCandidates' | 'maxProofNodes'>;
  readonly reasons: Set<string>;
  readonly sourceRoleMatcher?: SourceRoleMatcher;
  readonly signal?: AbortSignal;
}

async function addConventionCandidates(
  files: readonly string[],
  context: ConventionCandidateContext,
): Promise<void> {
  const byPath = new Map(context.inventory.files.map((fact) => [fact.path, fact]));
  const tests = context.inventory.files
    .filter(
      (fact) =>
        fact.roles.includes('test') || context.sourceRoleMatcher?.matches(fact.path) === true,
    )
    .sort((left, right) => compareCodePointStrings(left.path, right.path));
  let work = 0;
  for (const changedFile of files) {
    const changed = byPath.get(changedFile);
    for (const test of tests) {
      throwIfAborted(context.signal);
      const hasCapacity = addConventionCandidate({
        changedFile,
        changed,
        test,
        candidates: context.candidates,
        maxCandidates: context.limits.maxCandidates,
        reasons: context.reasons,
        maxProofNodes: context.limits.maxProofNodes,
      });
      if (!hasCapacity) return;
      work++;
      if (work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(context.signal);
    }
  }
}

function commandKey(command: VerificationCommand): string {
  return `${command.cwd}\u0000${command.argv.join('\u0000')}`;
}

const TIER_RANK = { focused: 0, package: 1, full: 2 } as const;

function packageNamesForSelection(
  inventory: ProjectInventorySnapshot,
  files: readonly string[],
  candidates: readonly Candidate[],
): ReadonlySet<string> {
  const fileByPath = new Map(inventory.files.map((fact) => [fact.path, fact]));
  const packageNames = new Set<string>();
  for (const file of files) {
    const packageName = fileByPath.get(file)?.packageName;
    if (packageName !== undefined) packageNames.add(packageName);
  }
  for (const candidate of candidates) {
    const packageName = fileByPath.get(candidate.selected.path)?.packageName;
    if (packageName !== undefined) packageNames.add(packageName);
  }
  return packageNames;
}

function compareCommands(left: VerificationCommand, right: VerificationCommand): number {
  const tierOrder = TIER_RANK[left.tier] - TIER_RANK[right.tier];
  if (tierOrder !== 0) return tierOrder;
  return compareCodePointStrings(commandKey(left), commandKey(right));
}

function inventoryCommands(
  inventory: ProjectInventorySnapshot,
  packageNames: ReadonlySet<string>,
  tier: NonNullable<StaticTestSelectionOptions['tier']>,
): VerificationCommand[] {
  const byKey = new Map<string, VerificationCommand>();
  for (const pkg of inventory.packages) {
    // A root command is the conservative full-repository fallback for leaf
    // packages that do not declare their own verification script.
    if (packageNames.size > 0 && !packageNames.has(pkg.name) && pkg.root !== '.') continue;
    for (const command of pkg.verificationCommands) {
      if (TIER_RANK[command.tier] < TIER_RANK[tier]) continue;
      const key = commandKey(command);
      if (!byKey.has(key)) byKey.set(key, command);
    }
  }
  return [...byKey.values()].sort(compareCommands);
}

interface SelectCommandsInput {
  readonly inventory: ProjectInventorySnapshot;
  readonly files: readonly string[];
  readonly candidates: readonly Candidate[];
  readonly tier: NonNullable<StaticTestSelectionOptions['tier']>;
  readonly maxCommands: number;
  readonly reasons: Set<string>;
}

function selectCommands(input: SelectCommandsInput): readonly VerificationCommand[] {
  const { inventory, files, candidates, tier, maxCommands, reasons } = input;
  const packageNames = packageNamesForSelection(inventory, files, candidates);
  const ordered = inventoryCommands(inventory, packageNames, tier);
  if (ordered.length === 0) {
    reasons.add('test-selection-verification-command-missing');
  }
  if (ordered.length > maxCommands) reasons.add('test-selection-command-cap');
  return ordered.slice(0, maxCommands);
}

function deriveFallbackTier(
  candidates: readonly Candidate[],
  commands: readonly VerificationCommand[],
): TestSelectionSnapshot['trust']['fallbackTier'] {
  if (candidates.length > 0 && commands.some((command) => command.tier === 'focused')) {
    return 'focused';
  }
  if (commands.some((command) => command.tier === 'package')) return 'package';
  return 'full';
}

interface SelectionLimits {
  readonly maxDepth: number;
  readonly maxCandidates: number;
  readonly maxCommands: number;
  readonly maxProofNodes: number;
}

interface SelectionState {
  readonly fileByPath: ReadonlyMap<string, FileFact>;
  readonly occurrencesByFile: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  readonly reverse: ReadonlyMap<string, readonly ReverseEvidence[]>;
  readonly ambiguousBodyHashes: ReadonlySet<string>;
  readonly inventoryReasons: Set<string>;
  readonly evidenceReasons: Set<string>;
  readonly projectionReasons: Set<string>;
  readonly candidates: Map<string, Candidate>;
  readonly queue: QueueEntry[];
  readonly visited: Map<string, number>;
  readonly edgeCount: { value: number };
  readonly sourceRoleMatcher?: SourceRoleMatcher;
}

function cappedInteger(value: number | undefined, fallback: number, cap: number): number {
  const candidate = value === undefined || !Number.isFinite(value) ? fallback : value;
  return Math.min(Math.max(Math.trunc(candidate), 0), cap);
}

function selectionLimits(options: StaticTestSelectionOptions): SelectionLimits {
  let maxProofNodes = cappedInteger(
    options.maxProofNodes,
    MAX_TEST_SELECTION_PROOF_NODES,
    MAX_TEST_SELECTION_PROOF_NODES,
  );
  if (options.includeProof === false) maxProofNodes = 0;
  return {
    maxDepth: cappedInteger(options.maxDepth, MAX_TEST_SELECTION_DEPTH, MAX_TEST_SELECTION_DEPTH),
    maxCandidates: Math.max(
      1,
      cappedInteger(
        options.maxCandidates,
        MAX_TEST_SELECTION_CANDIDATES,
        MAX_TEST_SELECTION_CANDIDATES,
      ),
    ),
    maxCommands: Math.max(
      1,
      cappedInteger(options.maxCommands, MAX_TEST_SELECTION_COMMANDS, MAX_TEST_SELECTION_COMMANDS),
    ),
    maxProofNodes,
  };
}

function selectionGraphIdentity(catalog: Catalog, override: string | undefined): string {
  if (override !== undefined) return override;
  return catalogGenerationKey({
    language: catalog.language,
    cacheKey: catalog.cacheKey,
    filesFingerprint: catalog.filesFingerprint ?? '',
    builtAt: catalog.builtAt,
  });
}

async function indexOccurrencesByFile(
  indexes: Indexes,
  signal: AbortSignal | undefined,
): Promise<{
  readonly byFile: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  readonly malformedEvidence: boolean;
}> {
  const byFile = new Map<string, FunctionOccurrence[]>();
  let malformedEvidence = false;
  let work = 0;
  for (const occurrence of indexes.byOccId.values()) {
    throwIfAborted(signal);
    const filePath = safeProjectPath(occurrence.filePath);
    if (filePath === undefined || occurrenceId(occurrence) === undefined) {
      malformedEvidence = true;
      work++;
      if (work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
      continue;
    }
    const bucket = byFile.get(filePath) ?? [];
    bucket.push(occurrence);
    byFile.set(filePath, bucket);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  return { byFile, malformedEvidence };
}

async function createSelectionState(
  catalog: Catalog,
  indexes: Indexes,
  inventory: ProjectInventorySnapshot,
  sourceRoleMatcher: SourceRoleMatcher | undefined,
  signal: AbortSignal | undefined,
): Promise<SelectionState> {
  const inventoryReasons = new Set(inventory.coverage.reasonCodes);
  if (inventory.coverage.status !== 'complete') {
    inventoryReasons.add('test-selection-inventory-incomplete');
  }
  const fileByPath = new Map<string, FileFact>();
  let work = 0;
  for (const fact of inventory.files) {
    throwIfAborted(signal);
    const filePath = safeProjectPath(fact.path);
    if (filePath === undefined) inventoryReasons.add('test-selection-inventory-malformed');
    else fileByPath.set(filePath, fact);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  const [occurrenceIndex, reverseEvidence] = await Promise.all([
    indexOccurrencesByFile(indexes, signal),
    buildReverseEvidence(catalog, signal),
  ]);
  const ambiguousBodyHashes = new Set<string>();
  for (const [bodyHash, occurrences] of indexes.occurrencesByHash) {
    throwIfAborted(signal);
    if (occurrences.length > 1) ambiguousBodyHashes.add(bodyHash);
    work++;
    if (work % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  const evidenceReasons = new Set<string>();
  if (reverseEvidence.capped) evidenceReasons.add('test-selection-edge-cap');
  if (occurrenceIndex.malformedEvidence || reverseEvidence.malformedEvidence) {
    evidenceReasons.add(MALFORMED_EVIDENCE_REASON);
  }
  return {
    fileByPath,
    occurrencesByFile: occurrenceIndex.byFile,
    reverse: reverseEvidence.reverse,
    ambiguousBodyHashes,
    inventoryReasons,
    evidenceReasons,
    projectionReasons: new Set<string>(),
    candidates: new Map<string, Candidate>(),
    queue: [],
    visited: new Map<string, number>(),
    edgeCount: { value: 0 },
    sourceRoleMatcher,
  };
}

async function seedOccurrence(
  state: SelectionState,
  seed: FunctionOccurrence,
  sourceFile: string,
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  throwIfAborted(signal);
  if (isTestOccurrence(seed, state.fileByPath, state.sourceRoleMatcher)) {
    const identity = occurrenceId(seed);
    if (identity === undefined) {
      state.evidenceReasons.add(MALFORMED_EVIDENCE_REASON);
      return true;
    }
    addCandidate({
      candidates: state.candidates,
      occurrence: seed,
      entry: {
        hash: seed.bodyHash,
        occurrenceKey: identity,
        depth: 0,
        confidence: 'exact',
        basis: 'call',
        proof: [identity],
        sourceFile,
      },
      maxCandidates: limits.maxCandidates,
      reasons: state.evidenceReasons,
      maxProofNodes: limits.maxProofNodes,
    });
  }
  if (state.ambiguousBodyHashes.has(seed.bodyHash)) {
    state.evidenceReasons.add('test-selection-body-twin-ambiguous');
    return true;
  }
  for (const edge of state.reverse.get(seed.bodyHash) ?? []) {
    throwIfAborted(signal);
    if (state.edgeCount.value >= MAX_TEST_SELECTION_VISITED_EDGES) {
      state.evidenceReasons.add('test-selection-edge-cap');
      return false;
    }
    const seedIdentity = occurrenceId(seed);
    if (seedIdentity === undefined) {
      state.evidenceReasons.add(MALFORMED_EVIDENCE_REASON);
      return true;
    }
    state.edgeCount.value++;
    state.queue.push({
      hash: edge.fromHash,
      occurrenceKey: edge.fromOccurrence,
      depth: 1,
      confidence: edge.confidence,
      basis: edge.basis,
      proof: boundedProof([seedIdentity, edge.proof], limits.maxProofNodes, state.evidenceReasons),
      sourceFile,
    });
    if (state.edgeCount.value % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  return true;
}

async function seedFile(
  state: SelectionState,
  file: string,
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!state.fileByPath.has(file)) {
    state.inventoryReasons.add('test-selection-inventory-unmatched');
  }
  const seeds = state.occurrencesByFile.get(file) ?? [];
  if (seeds.length === 0) {
    state.evidenceReasons.add('test-selection-graph-unmatched');
    return true;
  }
  for (const seed of seeds) {
    if (!(await seedOccurrence(state, seed, file, limits, signal))) return false;
  }
  return true;
}

async function seedSelection(
  state: SelectionState,
  files: readonly string[],
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<{ readonly state: SelectionState; readonly complete: boolean }> {
  for (const file of files) {
    throwIfAborted(signal);
    if (!(await seedFile(state, file, limits, signal))) return { state, complete: false };
  }
  return { state, complete: true };
}

function addTestsForEntry(
  state: SelectionState,
  indexes: Indexes,
  entry: QueueEntry,
  limits: SelectionLimits,
): void {
  const occurrence = indexes.byOccId.get(entry.occurrenceKey);
  if (occurrence?.bodyHash !== entry.hash) {
    state.evidenceReasons.add('test-selection-occurrence-unavailable');
    return;
  }
  if (!isTestOccurrence(occurrence, state.fileByPath, state.sourceRoleMatcher)) return;
  addCandidate({
    candidates: state.candidates,
    occurrence,
    entry,
    maxCandidates: limits.maxCandidates,
    reasons: state.evidenceReasons,
    maxProofNodes: limits.maxProofNodes,
  });
}

function nextBasis(current: QueueEntry['basis'], edge: ReverseEvidence): QueueEntry['basis'] {
  return current === 'import' || edge.basis === 'import' ? 'import' : 'call';
}

async function enqueueNextEdges(
  state: SelectionState,
  entry: QueueEntry,
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const next = state.reverse.get(entry.hash) ?? [];
  if (state.ambiguousBodyHashes.has(entry.hash)) {
    if (next.length > 0) state.evidenceReasons.add('test-selection-body-twin-ambiguous');
    return true;
  }
  if (entry.depth >= limits.maxDepth) {
    if (next.length > 0) state.evidenceReasons.add('test-selection-depth-cap');
    return true;
  }
  for (const edge of next) {
    throwIfAborted(signal);
    if (state.edgeCount.value >= MAX_TEST_SELECTION_VISITED_EDGES) {
      state.evidenceReasons.add('test-selection-edge-cap');
      return false;
    }
    state.edgeCount.value++;
    state.queue.push({
      hash: edge.fromHash,
      occurrenceKey: edge.fromOccurrence,
      depth: entry.depth + 1,
      confidence: weakest(entry.confidence, edge.confidence),
      basis: nextBasis(entry.basis, edge),
      proof: boundedProof(
        [...entry.proof, edge.proof],
        limits.maxProofNodes,
        state.evidenceReasons,
      ),
      sourceFile: entry.sourceFile,
    });
    if (state.edgeCount.value % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  return true;
}

async function processTraversalEntry(
  state: SelectionState,
  indexes: Indexes,
  entry: QueueEntry,
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const visitKey = `${entry.sourceFile}\u0000${entry.occurrenceKey}`;
  const priorDepth = state.visited.get(visitKey);
  if (priorDepth !== undefined && priorDepth <= entry.depth) return true;
  state.visited.set(visitKey, entry.depth);
  addTestsForEntry(state, indexes, entry, limits);
  return enqueueNextEdges(state, entry, limits, signal);
}

async function traverseReverseEvidence(
  state: SelectionState,
  indexes: Indexes,
  limits: SelectionLimits,
  signal: AbortSignal | undefined,
): Promise<{ readonly state: SelectionState; readonly complete: boolean }> {
  let cursor = 0;
  throwIfAborted(signal);
  while (cursor < state.queue.length) {
    throwIfAborted(signal);
    if (state.visited.size >= MAX_TEST_SELECTION_VISITED_NODES) {
      state.evidenceReasons.add('test-selection-node-cap');
      return { state, complete: false };
    }
    const entry = state.queue[cursor++];
    if (entry === undefined) continue;
    if (!(await processTraversalEntry(state, indexes, entry, limits, signal))) {
      return { state, complete: false };
    }
    if (cursor % ASYNC_BATCH_SIZE === 0) await yieldToEventLoop(signal);
  }
  return { state, complete: true };
}

const MAX_TEST_SELECTION_REASON_CODES = 32;
const REASON_CAP = 'test-selection-reason-cap';

function orderedUniqueReasons(...groups: readonly ReadonlySet<string>[]): readonly string[] {
  return [...new Set(groups.flatMap((group) => [...group]))].sort(compareCodePointStrings);
}

function mergeReasonCodes(state: SelectionState): readonly string[] {
  const selectorReasons = orderedUniqueReasons(state.evidenceReasons, state.projectionReasons);
  const inventoryReasons = orderedUniqueReasons(state.inventoryReasons);
  const allReasons = orderedUniqueReasons(new Set([...selectorReasons, ...inventoryReasons]));
  if (allReasons.length <= MAX_TEST_SELECTION_REASON_CODES) return allReasons;
  const retained = new Set<string>([REASON_CAP]);
  for (const reason of [...selectorReasons, ...inventoryReasons]) {
    if (retained.size >= MAX_TEST_SELECTION_REASON_CODES) break;
    retained.add(reason);
  }
  return [...retained].sort(compareCodePointStrings);
}

function selectionStatus(
  candidateCount: number,
  reasonCount: number,
  uncoveredCount: number,
): TestSelectionSnapshot['trust']['status'] {
  if (candidateCount === 0) return 'fallback';
  if (reasonCount === 0 && uncoveredCount === 0) return 'complete';
  return 'partial';
}

interface ProjectSelectionInput {
  readonly catalog: Catalog;
  readonly inventory: ProjectInventorySnapshot;
  readonly requestedFiles: readonly string[];
  readonly state: SelectionState;
  readonly limits: SelectionLimits;
  readonly options: StaticTestSelectionOptions;
}

async function projectSelection(input: ProjectSelectionInput): Promise<StaticTestSelectionView> {
  const { catalog, inventory, requestedFiles, state, limits, options } = input;
  await addConventionCandidates(requestedFiles, {
    inventory,
    candidates: state.candidates,
    limits,
    reasons: state.evidenceReasons,
    sourceRoleMatcher: state.sourceRoleMatcher,
    signal: options.signal,
  });
  const orderedCandidates = [...state.candidates.values()].sort((left, right) =>
    compareSelected(left.selected, right.selected),
  );
  const covered = new Set(orderedCandidates.flatMap((candidate) => [...candidate.sourceFiles]));
  const uncoveredFiles = requestedFiles.filter((file) => !covered.has(file));
  if (uncoveredFiles.length > 0) {
    state.evidenceReasons.add('test-selection-uncovered-files');
  }
  const commands = selectCommands({
    inventory,
    files: requestedFiles,
    candidates: orderedCandidates,
    tier: options.tier ?? 'focused',
    maxCommands: limits.maxCommands,
    reasons: state.projectionReasons,
  });
  const reasonCodes = mergeReasonCodes(state);
  const withoutId: Omit<TestSelectionSnapshot, 'snapshotId'> = {
    schemaVersion: 1,
    files: requestedFiles,
    tests: orderedCandidates.map((candidate) => candidate.selected),
    commands,
    uncoveredFiles,
    trust: {
      status: selectionStatus(orderedCandidates.length, reasonCodes.length, uncoveredFiles.length),
      reasonCodes,
      fallbackTier: deriveFallbackTier(orderedCandidates, commands),
    },
    graphIdentity: selectionGraphIdentity(catalog, options.graphIdentity),
    inventoryIdentity: inventory.snapshotId,
  };
  return {
    snapshot: {
      ...withoutId,
      snapshotId: buildTestSelectionSnapshotIdentity(withoutId),
    },
    reasonCodes,
    coverage: rollupFacets({
      inventory: makeFacet(true, state.inventoryReasons),
      evidence: makeFacet(true, state.evidenceReasons),
      grouping: UNREQUESTED_FACET,
      projection: makeFacet(true, state.projectionReasons),
    }),
  };
}

/** Select bounded static test candidates. This function never executes commands. */
export async function selectStaticTests(
  catalog: Catalog,
  indexes: Indexes,
  inventory: ProjectInventorySnapshot,
  files: readonly string[],
  options: StaticTestSelectionOptions = {},
): Promise<Result<StaticTestSelectionView, GraphReadError>> {
  if (
    options.graphIdentity !== undefined &&
    (typeof options.graphIdentity !== 'string' ||
      !GRAPH_IDENTITY_PATTERN.test(options.graphIdentity))
  ) {
    return err(
      selectionError(
        'GRAPH.READ.TEST_SELECTION_GRAPH_IDENTITY_INVALID',
        'Test selection graph identity must be an exact bounded generation identity',
      ),
    );
  }
  const normalized = normalizeFiles(files);
  if (!normalized.ok) return normalized;
  try {
    const requestedFiles = normalized.value;
    const limits = selectionLimits(options);
    const state = await createSelectionState(
      catalog,
      indexes,
      inventory,
      options.sourceRoleMatcher,
      options.signal,
    );
    const seededState = await seedSelection(state, requestedFiles, limits, options.signal);
    const traversedState = await traverseReverseEvidence(
      seededState.state,
      indexes,
      limits,
      options.signal,
    );
    return ok(
      await projectSelection({
        catalog,
        inventory,
        requestedFiles,
        state: traversedState.state,
        limits,
        options,
      }),
    );
  } catch (error) {
    if (error instanceof TestSelectionCancelledError) {
      return err(
        selectionError(
          'GRAPH.READ.TEST_SELECTION_CANCELLED',
          'Static test selection was cancelled',
        ),
      );
    }
    return err(
      selectionError('GRAPH.READ.TEST_SELECTION_FAILED', 'Failed to build static test selection'),
    );
  }
}
