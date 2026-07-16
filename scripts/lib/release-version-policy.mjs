/**
 * Pure SemVer policy for the stable npm `latest` release lane.
 *
 * Acceptance candidates may use any exact SemVer, but this release workflow
 * moves the stable `latest` tag. Its candidate and previous source therefore
 * must be stable exact versions, and the candidate must have strictly greater
 * SemVer precedence. Build metadata is accepted but ignored for precedence, as
 * required by SemVer 2.0.0.
 */

const VERSION_NUMBER = /^(?:0|[1-9]\d*)$/u;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/u;
const NUMERIC_IDENTIFIER = /^\d+$/u;
const MAX_VERSION_LENGTH = 256;

/** Parse one exact SemVer without ranges, tags, paths, whitespace, or controls. */
export function parseReleaseVersion(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VERSION_LENGTH) {
    throw new TypeError('release version must be a bounded non-empty string');
  }
  if (hasControlCharacter(value) || value.trim() !== value) {
    throw new TypeError('release version must not contain whitespace or control characters');
  }
  const normalized = options.allowV === true && value.startsWith('v') ? value.slice(1) : value;
  const buildSplit = normalized.split('+');
  if (buildSplit.length > 2) {
    throw new TypeError('release version must be an exact semantic version');
  }
  const [versionAndPrerelease = '', build] = buildSplit;
  if (build !== undefined) validateIdentifierList(build, false);

  const prereleaseAt = versionAndPrerelease.indexOf('-');
  const core =
    prereleaseAt === -1 ? versionAndPrerelease : versionAndPrerelease.slice(0, prereleaseAt);
  const prereleaseText =
    prereleaseAt === -1 ? undefined : versionAndPrerelease.slice(prereleaseAt + 1);
  const coreParts = core.split('.');
  if (coreParts.length !== 3 || coreParts.some((part) => !VERSION_NUMBER.test(part))) {
    throw new TypeError('release version must be an exact semantic version');
  }
  const prerelease =
    prereleaseText === undefined ? [] : validateIdentifierList(prereleaseText, true);
  return Object.freeze({
    normalized,
    major: BigInt(coreParts[0]),
    minor: BigInt(coreParts[1]),
    patch: BigInt(coreParts[2]),
    prerelease: Object.freeze(prerelease),
    build,
  });
}

function validateIdentifierList(value, rejectNumericLeadingZero) {
  const identifiers = value.split('.');
  for (const identifier of identifiers) {
    if (!SEMVER_IDENTIFIER.test(identifier)) {
      throw new TypeError('release version contains an invalid semantic-version identifier');
    }
    if (
      rejectNumericLeadingZero &&
      NUMERIC_IDENTIFIER.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith('0')
    ) {
      throw new TypeError('release version has an invalid numeric prerelease identifier');
    }
  }
  return identifiers;
}

/** Normalize one stable exact release version. A leading `v` is opt-in. */
export function normalizeStableReleaseVersion(value, options = {}) {
  const parsed = parseReleaseVersion(value, options);
  if (parsed.prerelease.length > 0) {
    throw new TypeError('the npm latest release lane requires a stable version');
  }
  return parsed.normalized;
}

/**
 * Compare two validated exact SemVers by precedence. Returns -1, 0, or 1;
 * build metadata is intentionally ignored.
 */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (const field of ['major', 'minor', 'patch']) {
    const comparison = compareBigInt(a[field], b[field]);
    if (comparison !== 0) return comparison;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Require stable `candidate` to have strictly greater precedence than `previous`. */
export function assertStableUpgrade(candidate, previous) {
  const normalizedCandidate = normalizeStableReleaseVersion(candidate);
  const normalizedPrevious = normalizeStableReleaseVersion(previous);
  if (compareReleaseVersions(normalizedCandidate, normalizedPrevious) <= 0) {
    throw new RangeError('candidate must have greater SemVer precedence than previous latest');
  }
  return Object.freeze({ candidate: normalizedCandidate, previous: normalizedPrevious });
}

/**
 * Interpret the fixed public npm-registry package endpoint. Only an explicit
 * 404 proves first-publish absence; auth, throttling, server, network, and
 * unexpected redirect statuses are indeterminate and must fail closed.
 */
export function classifyNpmPackageHttpStatus(value) {
  const status = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(status)) throw new TypeError('npm registry HTTP status must be an integer');
  if (status === 200) return 'present';
  if (status === 404) return 'absent';
  throw new Error(`npm registry HTTP status ${String(status)} cannot prove package absence`);
}

/**
 * Select the greatest stable GitHub Release tag after excluding the candidate.
 * Every supplied stable-release tag must itself be a valid stable exact SemVer;
 * ambiguous equal-precedence build variants fail closed.
 */
export function selectNewestPriorStableRelease(candidate, releaseTags) {
  const normalizedCandidate = normalizeStableReleaseVersion(candidate);
  if (!Array.isArray(releaseTags)) throw new TypeError('release tags must be an array');
  let selected = null;
  for (const tag of releaseTags) {
    const normalized = normalizeStableReleaseVersion(tag, { allowV: true });
    if (normalized === normalizedCandidate) continue;
    if (selected === null) {
      selected = normalized;
      continue;
    }
    const comparison = compareReleaseVersions(normalized, selected);
    if (comparison > 0) {
      selected = normalized;
    } else if (comparison === 0 && normalized !== selected) {
      throw new Error('stable release tags contain ambiguous equal-precedence versions');
    }
  }
  return selected;
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = comparePrereleaseIdentifier(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return compareNumber(left.length, right.length);
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) return compareBigInt(BigInt(left), BigInt(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareBigInt(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumber(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}
