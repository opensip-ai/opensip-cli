/**
 * Pure host-classification evaluators (Plan 02 — macOS GA qualification).
 *
 * Classifies an observed host against the `PLATFORM_SUPPORT_ROWS` registry. Split
 * out of `platform-support.ts` to keep each module focused: `platform-support-
 * types.ts` owns the type vocabulary, `platform-support-rows.ts` owns the frozen
 * policy data, and this module owns the pure classification logic that reads it.
 *
 * Design invariants:
 *   - Pure functions of their explicit inputs: NO filesystem, process, or global
 *     reads; no module-level mutable state.
 *   - An unlisted host is `unqualified` (may work, no promise), never "cannot
 *     run"; only the complete published Intel/x64 tuple is `unsupported`.
 *   - `match: 'exact'` requires EVERY normative dimension observed and matching;
 *     a single missing dimension downgrades to `partial`.
 *
 * The type imports below are `import type` (erased at runtime), so the only
 * runtime dependency is the value import of the frozen rows — no import cycle.
 */

import { PLATFORM_SUPPORT_ROWS } from './platform-support-rows.js';
import { assertPlatformSupportRowsValid } from './platform-support-validate.js';

import type {
  HostSupportAssessment,
  ObservedHost,
  PlatformDimension,
  PlatformMatchLevel,
  PlatformMismatchReason,
  PlatformSupportRow,
  PlatformSupportStatus,
  PlatformSupportTuple,
  RuntimeHostFacts,
  RuntimeHostSupportProjection,
} from './platform-support-types.js';

const NUMERIC_VERSION_PART = /^(?:0|[1-9]\d*)$/;
const DECIMAL_IDENTIFIER = /^\d+$/;
const VERSION_IDENTIFIER = /^[0-9A-Za-z-]+$/;

/** Major of a complete numeric version (`v24.16.0` → 24), else undefined. */
function majorOf(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const trimmed = version.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const buildSplit = normalized.split('+');
  if (buildSplit.length > 2) return undefined;
  const [versionAndPrerelease = '', build] = buildSplit;
  if (build !== undefined && !validVersionIdentifiers(build, false)) return undefined;

  const prereleaseAt = versionAndPrerelease.indexOf('-');
  const core =
    prereleaseAt === -1 ? versionAndPrerelease : versionAndPrerelease.slice(0, prereleaseAt);
  const prerelease = prereleaseAt === -1 ? undefined : versionAndPrerelease.slice(prereleaseAt + 1);
  if (prerelease !== undefined && !validVersionIdentifiers(prerelease, true)) return undefined;
  // The major must be strict (no leading zero); later numeric components may be
  // plain digits, including a leading-zero calendar minor like Ubuntu's "24.04".
  const [major, ...rest] = core.split('.');
  if (
    major === undefined ||
    !NUMERIC_VERSION_PART.test(major) ||
    rest.some((part) => !DECIMAL_IDENTIFIER.test(part))
  ) {
    return undefined;
  }
  const value = Number.parseInt(major, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

function validVersionIdentifiers(value: string, rejectNumericLeadingZero: boolean): boolean {
  return value.split('.').every((identifier) => {
    if (!VERSION_IDENTIFIER.test(identifier)) return false;
    return !(
      rejectNumericLeadingZero &&
      DECIMAL_IDENTIFIER.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith('0')
    );
  });
}

/** Per-dimension outcome against a tuple: present+match, present+mismatch, absent. */
type DimensionOutcome = 'match' | 'mismatch' | 'unobserved';

interface DimensionSpec {
  readonly dimension: PlatformDimension;
  readonly reason: PlatformMismatchReason;
  readonly evaluate: (observed: ObservedHost, tuple: PlatformSupportTuple) => DimensionOutcome;
}

function compare<T>(actual: T | undefined, expected: T): DimensionOutcome {
  if (actual === undefined) return 'unobserved';
  return actual === expected ? 'match' : 'mismatch';
}

function compareMajor(version: string | undefined, expected: number): DimensionOutcome {
  if (version === undefined) return 'unobserved';
  const major = majorOf(version);
  return major === undefined || major !== expected ? 'mismatch' : 'match';
}

function evaluateFilesystem(observed: ObservedHost, tuple: PlatformSupportTuple): DimensionOutcome {
  if (observed.filesystemType === undefined) return 'unobserved';
  return observed.filesystemType.toLowerCase() === tuple.filesystemType ? 'match' : 'mismatch';
}

function evaluateInstallChannel(
  observed: ObservedHost,
  tuple: PlatformSupportTuple,
): DimensionOutcome {
  if (observed.installChannel === undefined) return 'unobserved';
  return tuple.installChannels.includes(observed.installChannel) ? 'match' : 'mismatch';
}

const DIMENSION_SPECS: readonly DimensionSpec[] = [
  {
    dimension: 'os-platform',
    reason: 'os-platform-mismatch',
    evaluate: (o, t) => compare(o.osPlatform, t.osPlatform),
  },
  {
    dimension: 'os-version',
    reason: 'os-version-mismatch',
    evaluate: (o, t) => compareMajor(o.osVersion, t.osVersionMajor),
  },
  {
    dimension: 'kernel-name',
    reason: 'kernel-name-mismatch',
    evaluate: (o, t) => compare(o.kernelName, t.kernelName),
  },
  {
    dimension: 'kernel-version',
    reason: 'kernel-version-mismatch',
    evaluate: (o, t) => compareMajor(o.kernelRelease, t.kernelVersionMajor),
  },
  {
    dimension: 'arch',
    reason: 'arch-mismatch',
    evaluate: (o, t) => compare(o.arch, t.arch),
  },
  {
    dimension: 'node-major',
    reason: 'node-major-mismatch',
    evaluate: (o, t) => compareMajor(o.nodeVersion, t.nodeVersionMajor),
  },
  {
    dimension: 'node-abi',
    reason: 'node-abi-mismatch',
    evaluate: (o, t) => compare(o.nodeAbi, t.nodeAbi),
  },
  {
    dimension: 'npm-major',
    reason: 'npm-major-mismatch',
    evaluate: (o, t) => compareMajor(o.npmVersion, t.npmVersionMajor),
  },
  {
    dimension: 'filesystem-type',
    reason: 'filesystem-type-mismatch',
    evaluate: evaluateFilesystem,
  },
  {
    dimension: 'case-sensitivity',
    reason: 'case-sensitivity-mismatch',
    evaluate: (o, t) => compare(o.caseSensitive, t.caseSensitive),
  },
  {
    dimension: 'install-channel',
    reason: 'install-channel-mismatch',
    evaluate: evaluateInstallChannel,
  },
];

/**
 * A sentinel tuple used only to detect which OBSERVATION fields are present: a
 * dimension spec returns `unobserved` iff its source observation field is absent,
 * regardless of the tuple value it is compared against. The concrete values here
 * are never asserted — only presence/absence of the observed field is read.
 */
const PRESENCE_PROBE_TUPLE: PlatformSupportTuple = {
  osPlatform: '',
  osName: '',
  osVersionMajor: 0,
  osVersionRange: '',
  kernelName: '',
  kernelVersionMajor: 0,
  kernelVersionRange: '',
  arch: '',
  nodeVersionMajor: 0,
  nodeAbi: '',
  npmVersionMajor: 0,
  filesystemType: '',
  caseSensitive: false,
  installChannels: [],
};

interface DimensionEvaluation {
  readonly observed: PlatformDimension[];
  readonly unobserved: PlatformDimension[];
  readonly reasonCodes: PlatformMismatchReason[];
}

function classifyAgainst(observed: ObservedHost, tuple: PlatformSupportTuple): DimensionEvaluation {
  const evaluation: DimensionEvaluation = {
    observed: [],
    unobserved: [],
    reasonCodes: [],
  };
  for (const spec of DIMENSION_SPECS) {
    const outcome = spec.evaluate(observed, tuple);
    if (outcome === 'unobserved') {
      evaluation.unobserved.push(spec.dimension);
      continue;
    }
    evaluation.observed.push(spec.dimension);
    if (outcome === 'mismatch') evaluation.reasonCodes.push(spec.reason);
  }
  return evaluation;
}

function matchLevel(evaluation: DimensionEvaluation): PlatformMatchLevel {
  if (evaluation.reasonCodes.length > 0) return 'none';
  return evaluation.unobserved.length === 0 ? 'exact' : 'partial';
}

function freezeAssessment(
  status: PlatformSupportStatus,
  row: PlatformSupportRow | undefined,
  match: PlatformMatchLevel,
  evaluation: DimensionEvaluation,
  reasonCodes: readonly PlatformMismatchReason[],
): HostSupportAssessment {
  return Object.freeze({
    status,
    row,
    match,
    observed: Object.freeze([...evaluation.observed]),
    unobserved: Object.freeze([...evaluation.unobserved]),
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

/**
 * Classify an observed host against the platform-support registry — pure, with
 * no filesystem/process/global reads. Registry-driven and multi-platform: the
 * host's (platform, arch) selects a candidate row, then every normative dimension
 * is classified against that row's tuple. A host whose (platform, arch) has no
 * row is `unqualified` (may work, no promise), never "cannot run"; only an exact
 * match to an `unsupported` row is `unsupported`.
 */
export function assessHostSupport(
  observed: ObservedHost,
  rows: readonly PlatformSupportRow[] = PLATFORM_SUPPORT_ROWS,
): HostSupportAssessment {
  assertPlatformSupportRowsValid(rows);

  // Selecting a support row requires both the operating-system family and the
  // architecture. A partially/entirely unidentified host is unqualified — it
  // must not inherit a row it has merely not contradicted yet.
  if (observed.osPlatform === undefined || observed.arch === undefined) {
    return freezeAssessment('unqualified', undefined, 'none', presenceEvaluation(observed), [
      'insufficient-host-facts',
    ]);
  }

  // Candidate rows for this host's (platform, arch). The registry forbids two
  // rows overlapping on (platform, osVersionMajor, arch), so multiple candidates
  // only ever differ by OS-version major; pick the one the host best matches.
  const candidates = rows.filter(
    (row) => row.tuple.osPlatform === observed.osPlatform && row.tuple.arch === observed.arch,
  );
  if (candidates.length === 0) {
    return freezeAssessment('unqualified', undefined, 'none', presenceEvaluation(observed), [
      'unqualified-host',
    ]);
  }

  const { row, evaluation } = selectBestCandidate(observed, candidates);

  // A contradicted normative dimension means this is not that exact tuple:
  // unqualified with the specific reason codes.
  if (evaluation.reasonCodes.length > 0) {
    return freezeAssessment('unqualified', undefined, 'none', evaluation, evaluation.reasonCodes);
  }

  // An `unsupported` row is one exact published exclusion — only an EXACT match
  // (every normative dimension observed) resolves to `unsupported`; a partial
  // match belongs to the broader unqualified set.
  if (row.status === 'unsupported') {
    if (evaluation.unobserved.length > 0) {
      return freezeAssessment('unqualified', undefined, 'none', evaluation, [
        'insufficient-host-facts',
      ]);
    }
    return freezeAssessment('unsupported', row, 'exact', evaluation, ['unsupported-tuple']);
  }

  // A `preview`/`supported` row: exact only when every normative dimension was
  // observed, otherwise partial.
  return freezeAssessment(row.status, row, matchLevel(evaluation), evaluation, []);
}

/**
 * Among rows sharing the host's (platform, arch), pick the one the host best
 * matches: a contradiction-free candidate always beats a contradicted one; ties
 * break toward the most observed dimensions, then registry order.
 */
function selectBestCandidate(
  observed: ObservedHost,
  candidates: readonly PlatformSupportRow[],
): { readonly row: PlatformSupportRow; readonly evaluation: DimensionEvaluation } {
  let best: {
    row: PlatformSupportRow;
    evaluation: DimensionEvaluation;
    clean: boolean;
    score: number;
  } | null = null;
  for (const row of candidates) {
    const evaluation = classifyAgainst(observed, row.tuple);
    const clean = evaluation.reasonCodes.length === 0;
    const score = evaluation.observed.length;
    if (best === null || (clean && !best.clean) || (clean === best.clean && score > best.score)) {
      best = { row, evaluation, clean, score };
    }
  }
  if (best === null) {
    // Unreachable: callers only pass a non-empty candidate list.
    throw new Error('selectBestCandidate requires at least one candidate');
  }
  return { row: best.row, evaluation: best.evaluation };
}

/**
 * Report which normative dimensions were present in the observation, independent
 * of any row — used when no row is selected (insufficient facts, or no row for
 * the host's (platform, arch)). A dimension is "observed" when its source field
 * is present, regardless of value.
 */
function presenceEvaluation(observed: ObservedHost): DimensionEvaluation {
  const evaluation: DimensionEvaluation = { observed: [], unobserved: [], reasonCodes: [] };
  for (const spec of DIMENSION_SPECS) {
    const present = spec.evaluate(observed, PRESENCE_PROBE_TUPLE) !== 'unobserved';
    (present ? evaluation.observed : evaluation.unobserved).push(spec.dimension);
  }
  return evaluation;
}

/**
 * Project support from the reliably process-observable facts (platform, arch,
 * Node version, Node ABI). npm, filesystem, case behavior, OS product version,
 * kernel name/version, and install channel are intentionally left unobserved, so
 * the result is never an exact match. Both host-support surfaces call this helper.
 */
export function projectRuntimeHostSupport(
  facts: RuntimeHostFacts,
  rows: readonly PlatformSupportRow[] = PLATFORM_SUPPORT_ROWS,
): RuntimeHostSupportProjection {
  const observed: ObservedHost = {
    osPlatform: facts.platform,
    arch: facts.arch,
    nodeVersion: facts.nodeVersion,
    nodeAbi: facts.nodeAbi,
  };
  const assessment = assessHostSupport(observed, rows);
  // The runtime subset always leaves normative dimensions unobserved, so a
  // clean projection is `partial`, never `exact`.
  const match: 'partial' | 'none' = assessment.match === 'none' ? 'none' : 'partial';
  return Object.freeze({
    status: assessment.status,
    match,
    rowId: assessment.row?.id ?? null,
    rowStatus: assessment.row?.status ?? null,
    profile: assessment.row?.profile ?? null,
    docsUrl: assessment.row?.docsUrl ?? null,
    reasonCodes: assessment.reasonCodes,
    observed: assessment.observed,
    unobserved: assessment.unobserved,
  });
}
