import {
  lstatSync as defaultLstatSync,
  readdirSync as defaultReaddirSync,
  realpathSync as defaultRealpathSync,
  statSync as defaultStatSync,
} from 'node:fs';
import { resolve } from 'node:path';

import {
  DISTRIBUTION_FAMILY_PACKAGE_KINDS,
  DISTRIBUTION_LANGUAGE_FAMILIES,
  DISTRIBUTION_MAX_DEPENDENCY_ROWS,
  DISTRIBUTION_MEASURE_MAX_REPEATS,
} from './distribution-footprint-constants.mjs';
import {
  arraysEqual,
  boundedIdentity,
  codePointCompare,
  nonnegativeSafeInteger,
  positiveSafeInteger,
  requireRecord,
  requiredString,
  sumSafeIntegers,
} from './distribution-footprint-values.mjs';
import {
  discoverTarballFiles,
  expectedTarballEntries,
  normalizeVersion,
} from './release-artifacts.mjs';
import { median, nearestRankPercentile } from '../perf/statistics.mjs';

const DISTRIBUTION_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function normalizeDistributionVersion(value, source = 'version') {
  const version = normalizeVersion(value);
  if (version.length > 128 || !DISTRIBUTION_VERSION_PATTERN.test(version)) {
    throw new Error(`${source} must be a release semantic version`);
  }
  return version;
}

/** Identify exact first-party packages attributable to one of the six language families. */
export function languageFamilyForPackage(packageName) {
  if (typeof packageName !== 'string') return;
  const match = /^@opensip-cli\/(lang|checks|graph)-(typescript|rust|python|go|java|cpp)$/u.exec(
    packageName,
  );
  return match?.[2];
}

/** Build deterministic language-family rows from canonical tarball and logical-size rows. */
export function groupLanguageFamilyPackages(tarballRows, resolvedPackageRows) {
  const version = releaseVersionFromRows(tarballRows);
  const normalizedTarballs = normalizeReleaseTarballRows(tarballRows, version);
  const logicalByName = normalizeResolvedPackageRows(resolvedPackageRows);
  const tarballByName = new Map(normalizedTarballs.map((row) => [row.packageName, row]));

  return DISTRIBUTION_LANGUAGE_FAMILIES.map((language) => {
    const packages = DISTRIBUTION_FAMILY_PACKAGE_KINDS.map(
      (kind) => `@opensip-cli/${kind}-${language}`,
    )
      .filter((packageName) => tarballByName.has(packageName))
      .map((packageName) => {
        const logical = logicalByName.get(packageName);
        if (logical === undefined) {
          throw new Error(`missing resolved-package accounting for ${packageName}`);
        }
        return {
          packageName,
          compressedBytes: tarballByName.get(packageName).compressedBytes,
          unpackedBytes: logical.unpackedBytes,
        };
      });
    return {
      language,
      packages,
      compressedBytes: sumSafeIntegers(
        packages.map((entry) => entry.compressedBytes),
        `${language} compressed bytes`,
      ),
      unpackedBytes: sumSafeIntegers(
        packages.map((entry) => entry.unpackedBytes),
        `${language} unpacked bytes`,
      ),
    };
  });
}

export function groupLanguageFamilyFootprints(tarballRows, resolvedPackageRows) {
  return groupLanguageFamilyPackages(tarballRows, resolvedPackageRows);
}

/** Validate raw duration samples and calculate reproducible median and nearest-rank p95. */
export function summarizeDurationSamples(samples) {
  const samplesMs = normalizedDurationSamples(samples);
  return {
    samplesMs,
    medianMs: median(samplesMs),
    p95Ms: nearestRankPercentile(samplesMs, 95),
  };
}

/** Validate a complete release-tarball row set and return it in canonical release order. */
export function normalizeReleaseTarballRows(rows, expectedVersion, source = 'release.tarballs') {
  const version = normalizeDistributionVersion(expectedVersion, 'expectedVersion');
  if (!Array.isArray(rows)) throw new TypeError(`${source} must be an array`);

  const expected = expectedTarballEntries(version);
  const rowCount = rows.length;
  if (rowCount > expected.length) {
    throw new Error(`${source} must contain exactly ${String(expected.length)} package rows`);
  }
  const expectedByName = new Map(expected.map((entry) => [entry.packageName, entry]));
  const byName = new Map();
  for (const index of numericIndices(rowCount)) {
    const rawRow = rows[index];
    const row = requireRecord(rawRow, `${source}[${String(index)}]`);
    const packageName = requiredString(row.packageName, `${source}[${String(index)}].packageName`);
    if (!expectedByName.has(packageName)) {
      throw new Error(`${source}[${String(index)}] has unexpected package ${packageName}`);
    }
    if (byName.has(packageName)) throw new Error(`${source} has duplicate package ${packageName}`);

    const rowVersion = normalizeDistributionVersion(
      requiredString(row.version, `${source}[${String(index)}].version`),
      `${source}[${String(index)}].version`,
    );
    if (rowVersion !== version) {
      throw new Error(`${source}[${String(index)}].version must be ${version}`);
    }
    const fileName = requiredString(row.fileName, `${source}[${String(index)}].fileName`);
    if (fileName !== expectedByName.get(packageName).fileName) {
      throw new Error(`${source}[${String(index)}].fileName is not canonical for ${packageName}`);
    }
    byName.set(packageName, {
      packageName,
      version,
      fileName,
      compressedBytes: positiveSafeInteger(
        row.compressedBytes,
        `${source}[${String(index)}].compressedBytes`,
      ),
    });
  }

  const missing = expected.filter((entry) => !byName.has(entry.packageName));
  if (missing.length > 0) {
    throw new Error(
      `${source} is incomplete; missing ${missing.map((entry) => entry.packageName).join(', ')}`,
    );
  }
  if (rowCount !== expected.length) {
    throw new Error(`${source} must contain exactly ${String(expected.length)} package rows`);
  }
  return expected.map((entry) => byName.get(entry.packageName));
}

/** Stat the exact canonical tarball set in a directory without accepting symlinked artifacts. */
export function collectReleaseTarballRows(artifactDir, expectedVersion, dependencies = {}) {
  const version = normalizeDistributionVersion(expectedVersion, 'expectedVersion');
  const readdirSync = dependencies.readdirSync ?? defaultReaddirSync;
  const lstatSync = dependencies.lstatSync ?? defaultLstatSync;
  const realpathSync = dependencies.realpathSync ?? defaultRealpathSync;
  const statSync = dependencies.statSync ?? defaultStatSync;
  const discover = dependencies.discoverTarballFiles ?? discoverTarballFiles;
  const resolvedDir = realpathSync(resolve(artifactDir));
  if (!statSync(resolvedDir).isDirectory()) throw new Error(`${artifactDir} is not a directory`);

  const expectedNames = expectedTarballEntries(version)
    .map((entry) => entry.fileName)
    .sort(codePointCompare);
  const actualNames = readdirSync(resolvedDir)
    .filter((name) => name.endsWith('.tgz'))
    .sort(codePointCompare);
  if (!arraysEqual(actualNames, expectedNames)) {
    throw new Error('artifact directory must contain the exact complete release tarball set');
  }

  const rows = discover(resolvedDir, version).map((entry) => {
    if (!entry.exists) throw new Error(`missing release tarball ${entry.fileName}`);
    const info = lstatSync(entry.filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`release tarball ${entry.fileName} must be a regular file, not a symlink`);
    }
    return {
      packageName: entry.packageName,
      version,
      fileName: entry.fileName,
      compressedBytes: positiveSafeInteger(info.size, `${entry.fileName} size`),
    };
  });
  return normalizeReleaseTarballRows(rows, version);
}

/** Sum the complete canonical release-set compressed bytes with safe-integer enforcement. */
export function sumReleaseSetCompressedBytes(tarballRows) {
  const version = releaseVersionFromRows(tarballRows);
  const rows = normalizeReleaseTarballRows(tarballRows, version);
  return sumSafeIntegers(
    rows.map((entry) => entry.compressedBytes),
    'complete release-set compressed bytes',
  );
}

/** Normalize identity/version rows from the installed dependency closure. */
export function normalizeDependencyClosure(rows, source = 'install.dependencyClosure') {
  if (!Array.isArray(rows)) throw new TypeError(`${source} must be an array`);
  const rowCount = rows.length;
  if (rowCount === 0 || rowCount > DISTRIBUTION_MAX_DEPENDENCY_ROWS) {
    throw new RangeError(
      `${source} must contain between 1 and ${String(DISTRIBUTION_MAX_DEPENDENCY_ROWS)} rows`,
    );
  }

  const seen = new Set();
  const normalized = [];
  for (const index of numericIndices(rowCount)) {
    const rawRow = rows[index];
    const row = requireRecord(rawRow, `${source}[${String(index)}]`);
    const name = boundedIdentity(row.name, `${source}[${String(index)}].name`);
    const version = boundedIdentity(row.version, `${source}[${String(index)}].version`);
    const identity = `${name}\u0000${version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({ name, version });
  }
  normalized.sort(
    (left, right) =>
      codePointCompare(left.name, right.name) || codePointCompare(left.version, right.version),
  );
  return normalized;
}

/** Calculate the compressed tarball total for OpenSIP packages actually in the CLI closure. */
export function calculateInstalledCliClosureCompressedBytes(dependencyClosure, tarballRows) {
  const version = releaseVersionFromRows(tarballRows);
  const rows = normalizeReleaseTarballRows(tarballRows, version);
  const closure = normalizeDependencyClosure(dependencyClosure);
  const tarballByName = new Map(rows.map((entry) => [entry.packageName, entry]));
  const openSipRows = closure.filter((entry) => isOpenSipPackage(entry.name));
  if (!openSipRows.some((entry) => entry.name === 'opensip-cli')) {
    throw new Error('installed dependency closure must include opensip-cli');
  }

  const names = new Set();
  for (const dependency of openSipRows) {
    const tarball = tarballByName.get(dependency.name);
    if (tarball === undefined) {
      throw new Error(`installed OpenSIP package ${dependency.name} has no canonical tarball row`);
    }
    if (dependency.version !== tarball.version) {
      throw new Error(
        `installed OpenSIP package ${dependency.name}@${dependency.version} does not match ${tarball.version}`,
      );
    }
    names.add(dependency.name);
  }
  return sumSafeIntegers(
    [...names].map((name) => tarballByName.get(name).compressedBytes),
    'installed CLI closure compressed bytes',
  );
}

function normalizedDurationSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError('duration samples must be a non-empty array');
  }
  const sampleCount = samples.length;
  if (sampleCount === 0) {
    throw new TypeError('duration samples must be a non-empty array');
  }
  if (sampleCount > DISTRIBUTION_MEASURE_MAX_REPEATS) {
    throw new RangeError(
      `duration samples must not exceed ${String(DISTRIBUTION_MEASURE_MAX_REPEATS)}`,
    );
  }
  return numericIndices(sampleCount).map((index) => {
    const sample = samples[index];
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0) {
      throw new RangeError(`duration samples[${String(index)}] must be finite and non-negative`);
    }
    return sample;
  });
}

function normalizeResolvedPackageRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('resolvedPackageRows must be an array');
  const result = new Map();
  const rowCount = rows.length;
  if (rowCount > 64) throw new RangeError('resolvedPackageRows must not exceed 64 rows');
  for (const index of numericIndices(rowCount)) {
    const rawRow = rows[index];
    const row = requireRecord(rawRow, `resolvedPackageRows[${String(index)}]`);
    const packageName = requiredString(
      row.packageName,
      `resolvedPackageRows[${String(index)}].packageName`,
    );
    if (result.has(packageName)) {
      throw new Error(`resolvedPackageRows has duplicate package ${packageName}`);
    }
    result.set(packageName, {
      unpackedBytes: nonnegativeSafeInteger(
        row.unpackedBytes,
        `resolvedPackageRows[${String(index)}].unpackedBytes`,
      ),
    });
  }
  return result;
}

function releaseVersionFromRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('release tarball rows must be an array');
  const rowCount = rows.length;
  if (rowCount > 128) throw new RangeError('release tarball rows must not exceed 128 rows');
  let cliRow;
  for (const index of numericIndices(rowCount)) {
    const row = rows[index];
    if (row !== null && typeof row === 'object' && row.packageName === 'opensip-cli') {
      cliRow = row;
      break;
    }
  }
  if (cliRow === undefined) throw new Error('release tarball rows must include opensip-cli');
  return normalizeDistributionVersion(
    requiredString(cliRow.version, 'opensip-cli tarball version'),
    'opensip-cli tarball version',
  );
}

function isOpenSipPackage(name) {
  return name === 'opensip-cli' || name.startsWith('@opensip-cli/');
}

function numericIndices(length) {
  return Array.from({ length }, (_unused, index) => index);
}
