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

import {
  MACOS_INTEL_ROW,
  MACOS_PREVIEW_ROW,
  PLATFORM_SUPPORT_ROWS,
  assertPlatformSupportRowsValid,
} from './platform-support-rows.js';

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
  const coreParts = core.split('.');
  if (coreParts.length === 0 || coreParts.some((part) => !NUMERIC_VERSION_PART.test(part))) {
    return undefined;
  }
  const value = Number.parseInt(coreParts[0] ?? '', 10);
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
 * no filesystem/process/global reads. It returns the applicable row (when one
 * applies), a match level, and the observed/unobserved dimensions plus stable
 * reason codes. An unlisted host is `unqualified` (may work, no promise), never
 * "cannot run"; only the complete published Intel/x64 tuple is `unsupported`.
 */
export function assessHostSupport(
  observed: ObservedHost,
  rows: readonly PlatformSupportRow[] = PLATFORM_SUPPORT_ROWS,
): HostSupportAssessment {
  assertPlatformSupportRowsValid(rows);
  const { macosRow, intelRow } = resolveRegistryRows(rows);
  const macosTuple = macosRow.tuple;
  const macosEval = classifyAgainst(observed, macosTuple);

  // Non-macOS host: not classified by this OS contract (belongs to a later OS
  // profile). Report unqualified, never a "cannot run" claim.
  if (observed.osPlatform !== undefined && observed.osPlatform !== macosTuple.osPlatform) {
    return freezeAssessment('unqualified', undefined, 'none', macosEval, ['non-macos-host']);
  }

  // Selecting an OS-specific support row requires enough identity to establish
  // both the operating-system family and architecture. Missing dimensions remain
  // unobserved, but an entirely/partially unidentified host must not inherit the
  // macOS row merely because it has not contradicted that row yet.
  if (observed.osPlatform === undefined || observed.arch === undefined) {
    return freezeAssessment('unqualified', undefined, 'none', macosEval, [
      'insufficient-host-facts',
    ]);
  }

  // The exact Intel/x64 row is intentionally excluded (no Intel GA evidence).
  if (observed.osPlatform === macosTuple.osPlatform && observed.arch === intelRow.tuple.arch) {
    const intelEval = classifyAgainst(observed, intelRow.tuple);
    // The unsupported row is one exact published tuple, not a blanket claim
    // that every Intel Mac/runtime is unsupported. Any observed contradiction
    // or unobserved normative dimension belongs to the broader unqualified set.
    if (intelEval.reasonCodes.length > 0) {
      return freezeAssessment('unqualified', undefined, 'none', intelEval, intelEval.reasonCodes);
    }
    if (intelEval.unobserved.length > 0) {
      return freezeAssessment('unqualified', undefined, 'none', intelEval, [
        'insufficient-host-facts',
      ]);
    }
    return freezeAssessment(intelRow.status, intelRow, 'exact', intelEval, [
      'macos-intel-unsupported',
    ]);
  }

  // A contradicted dimension (wrong macOS/kernel/Node/ABI/npm/filesystem/case)
  // means this is not the supported tuple: unqualified with the reason codes.
  if (macosEval.reasonCodes.length > 0) {
    return freezeAssessment('unqualified', undefined, 'none', macosEval, macosEval.reasonCodes);
  }

  // No contradiction: advertise the preview row. Exact only when every normative
  // dimension was observed; otherwise partial.
  return freezeAssessment(macosRow.status, macosRow, matchLevel(macosEval), macosEval, []);
}

function resolveRegistryRows(rows: readonly PlatformSupportRow[]): {
  readonly macosRow: PlatformSupportRow;
  readonly intelRow: PlatformSupportRow;
} {
  const macosRow = rows.find((candidate) => candidate.id === MACOS_PREVIEW_ROW.id);
  const intelRow = rows.find((candidate) => candidate.id === MACOS_INTEL_ROW.id);
  if (macosRow === undefined || intelRow === undefined) {
    const missingId = macosRow === undefined ? MACOS_PREVIEW_ROW.id : MACOS_INTEL_ROW.id;
    throw new Error(`Platform-support registry is missing required row: ${missingId}`);
  }
  if (
    macosRow.tuple.osPlatform !== 'darwin' ||
    macosRow.tuple.arch !== 'arm64' ||
    macosRow.status === 'unsupported'
  ) {
    throw new Error(`Platform-support registry has an invalid macOS qualification row`);
  }
  if (
    intelRow.tuple.osPlatform !== 'darwin' ||
    intelRow.tuple.arch !== 'x64' ||
    intelRow.status !== 'unsupported'
  ) {
    throw new Error(`Platform-support registry has an invalid macOS Intel exclusion row`);
  }
  return { macosRow, intelRow };
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
