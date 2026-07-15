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
 *     run"; only Intel/x64 macOS is `unsupported`.
 *   - `match: 'exact'` requires EVERY normative dimension observed and matching;
 *     a single missing dimension downgrades to `partial`.
 *
 * The type imports below are `import type` (erased at runtime), so the only
 * runtime dependency is the value import of the frozen rows — no import cycle.
 */

import { MACOS_INTEL_ROW, MACOS_PREVIEW_ROW } from './platform-support-rows.js';

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

const INTEL_ARCHES = new Set(['x64', 'ia32']);

/** Leading integer major of a version string (`v24.16.0` → 24), else undefined. */
function majorOf(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const match = /\d+/.exec(version.trim().replace(/^v/, ''));
  if (match === null) return undefined;
  const value = Number.parseInt(match[0], 10);
  return Number.isNaN(value) ? undefined : value;
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
  const major = majorOf(version);
  return compare(major, expected);
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
    dimension: 'kernel-version',
    reason: 'kernel-version-mismatch',
    evaluate: (o, t) => compareMajor(o.kernelRelease, t.kernelVersionMajor),
  },
  { dimension: 'arch', reason: 'arch-mismatch', evaluate: (o, t) => compare(o.arch, t.arch) },
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
  const evaluation: DimensionEvaluation = { observed: [], unobserved: [], reasonCodes: [] };
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
 * "cannot run"; only Intel/x64 macOS is `unsupported`.
 */
export function assessHostSupport(observed: ObservedHost): HostSupportAssessment {
  const previewTuple = MACOS_PREVIEW_ROW.tuple;
  const previewEval = classifyAgainst(observed, previewTuple);

  // Non-macOS host: not classified by this OS contract (belongs to a later OS
  // profile). Report unqualified, never a "cannot run" claim.
  if (observed.osPlatform !== undefined && observed.osPlatform !== previewTuple.osPlatform) {
    return freezeAssessment('unqualified', undefined, 'none', previewEval, ['non-macos-host']);
  }

  // Intel/x64 macOS: categorically excluded (no Intel GA evidence).
  if (
    observed.osPlatform === previewTuple.osPlatform &&
    observed.arch !== undefined &&
    INTEL_ARCHES.has(observed.arch)
  ) {
    const intelEval = classifyAgainst(observed, MACOS_INTEL_ROW.tuple);
    return freezeAssessment('unsupported', MACOS_INTEL_ROW, matchLevel(intelEval), intelEval, [
      'macos-intel-unsupported',
    ]);
  }

  // A contradicted dimension (wrong macOS/kernel/Node/ABI/npm/filesystem/case)
  // means this is not the supported tuple: unqualified with the reason codes.
  if (previewEval.reasonCodes.length > 0) {
    return freezeAssessment('unqualified', undefined, 'none', previewEval, previewEval.reasonCodes);
  }

  // No contradiction: advertise the preview row. Exact only when every normative
  // dimension was observed; otherwise partial.
  return freezeAssessment('preview', MACOS_PREVIEW_ROW, matchLevel(previewEval), previewEval, []);
}

/**
 * Project support from the reliably process-observable facts (platform, arch,
 * Node version, Node ABI). npm, filesystem, case behavior, OS/kernel version and
 * install channel are intentionally left unobserved, so the result is never an
 * exact match. Both the CLI and MCP host-support surfaces call this helper.
 */
export function projectRuntimeHostSupport(facts: RuntimeHostFacts): RuntimeHostSupportProjection {
  const observed: ObservedHost = {
    osPlatform: facts.platform,
    arch: facts.arch,
    nodeVersion: facts.nodeVersion,
    nodeAbi: facts.nodeAbi,
  };
  const assessment = assessHostSupport(observed);
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
