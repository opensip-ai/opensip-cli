import {
  DISTRIBUTION_FOOTPRINT_CAVEATS,
  DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION,
  DISTRIBUTION_INSTALL_MODES,
  DISTRIBUTION_LANGUAGE_FAMILIES,
  DISTRIBUTION_MAX_CAVEATS,
  DISTRIBUTION_MAX_STRING_LENGTH,
  DISTRIBUTION_MEASURE_MAX_REPEATS,
  DISTRIBUTION_STARTUP_SCENARIOS,
} from './distribution-footprint-constants.mjs';
import { validateDistributionRegistryOrigin } from './distribution-footprint-args.mjs';
import {
  calculateInstalledCliClosureCompressedBytes,
  groupLanguageFamilyPackages,
  languageFamilyForPackage,
  normalizeDependencyClosure,
  normalizeDistributionVersion,
  normalizeReleaseTarballRows,
  sumReleaseSetCompressedBytes,
  summarizeDurationSamples,
} from './distribution-footprint-release.mjs';
import {
  boundedIdentity,
  isoTimestamp,
  nonnegativeFiniteNumber,
  nonnegativeSafeInteger,
  optionalSha256,
  positiveSafeInteger,
  requireRecord,
  requiredString,
} from './distribution-footprint-values.mjs';

const INSTALL_MODES = new Set(DISTRIBUTION_INSTALL_MODES);

/** Construct and normalize a schema-v1 distribution report. */
export function createDistributionFootprintReport(input, source = '<distribution-report>') {
  const record = requireRecord(input, source);
  return normalizeDistributionFootprintReport(
    { ...record, schemaVersion: DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION },
    source,
  );
}

/** Normalize schema-v1 input, ignoring unknown additive fields and recomputing derived data. */
export function normalizeDistributionFootprintReport(raw, source = '<distribution-report>') {
  const report = requireRecord(raw, source);
  if (report.schemaVersion !== DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION) {
    throw new Error(
      `${source}.schemaVersion must be ${String(DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION)}`,
    );
  }

  const environment = normalizeEnvironment(report.environment, `${source}.environment`);
  const releaseInput = requireRecord(report.release, `${source}.release`);
  const cliVersion = normalizeDistributionVersion(
    requiredString(releaseInput.cliVersion, `${source}.release.cliVersion`),
    `${source}.release.cliVersion`,
  );
  const tarballs = normalizeReleaseTarballRows(
    releaseInput.tarballs,
    cliVersion,
    `${source}.release.tarballs`,
  );
  const measurement = normalizeMeasurement(report.measurement, `${source}.measurement`);
  const install = normalizeInstall(report.install, `${source}.install`);
  const startup = normalizeStartup(report.startup, measurement.repeats, `${source}.startup`);
  const completeReleaseSetCompressedBytes = sumReleaseSetCompressedBytes(tarballs);
  const installedCliClosureCompressedBytes = calculateInstalledCliClosureCompressedBytes(
    install.dependencyClosure,
    tarballs,
  );
  assertOptionalDerivedTotal(
    releaseInput.completeReleaseSetCompressedBytes,
    completeReleaseSetCompressedBytes,
    `${source}.release.completeReleaseSetCompressedBytes`,
  );
  assertOptionalDerivedTotal(
    releaseInput.installedCliClosureCompressedBytes,
    installedCliClosureCompressedBytes,
    `${source}.release.installedCliClosureCompressedBytes`,
  );

  return {
    schemaVersion: DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION,
    generatedAt: isoTimestamp(report.generatedAt, `${source}.generatedAt`),
    environment,
    release: {
      cliVersion,
      gitSha: boundedIdentity(releaseInput.gitSha, `${source}.release.gitSha`),
      artifactSetSha256: optionalSha256(
        releaseInput.artifactSetSha256,
        `${source}.release.artifactSetSha256`,
      ),
      tarballs,
      completeReleaseSetCompressedBytes,
      installedCliClosureCompressedBytes,
    },
    measurement,
    install,
    startup,
    languageFamilies: normalizeReportLanguageFamilies(
      report.languageFamilies,
      tarballs,
      `${source}.languageFamilies`,
    ),
    caveats: normalizeCaveats(report.caveats, `${source}.caveats`),
  };
}

function normalizeEnvironment(value, source) {
  const environment = requireRecord(value, source);
  return {
    nodeVersion: boundedIdentity(environment.nodeVersion, `${source}.nodeVersion`),
    pnpmVersion: boundedIdentity(environment.pnpmVersion, `${source}.pnpmVersion`),
    npmVersion: boundedIdentity(environment.npmVersion, `${source}.npmVersion`),
    platform: boundedIdentity(environment.platform, `${source}.platform`),
    architecture: boundedIdentity(environment.architecture, `${source}.architecture`),
    osRelease:
      environment.osRelease === undefined || environment.osRelease === ''
        ? ''
        : boundedIdentity(environment.osRelease, `${source}.osRelease`),
  };
}

function normalizeMeasurement(value, source) {
  const measurement = requireRecord(value, source);
  const mode = requiredString(measurement.mode, `${source}.mode`);
  if (!INSTALL_MODES.has(mode)) throw new Error(`${source}.mode is not supported`);
  const repeats = positiveSafeInteger(measurement.repeats, `${source}.repeats`);
  if (repeats > DISTRIBUTION_MEASURE_MAX_REPEATS) {
    throw new RangeError(
      `${source}.repeats must not exceed ${String(DISTRIBUTION_MEASURE_MAX_REPEATS)}`,
    );
  }

  let registryOrigin = null;
  if (measurement.registryOrigin !== undefined && measurement.registryOrigin !== null) {
    registryOrigin = validateDistributionRegistryOrigin(
      measurement.registryOrigin,
      `${source}.registryOrigin`,
    );
  }
  if (mode === 'offline-cache' && registryOrigin !== null) {
    throw new Error(`${source}.registryOrigin must be absent in offline-cache mode`);
  }
  if (mode === 'registry-cold' && registryOrigin === null) {
    throw new Error(`${source}.registryOrigin is required in registry-cold mode`);
  }
  return { mode, repeats, registryOrigin };
}

function normalizeInstall(value, source) {
  const install = requireRecord(value, source);
  const dependencyClosure = normalizeDependencyClosure(
    install.dependencyClosure,
    `${source}.dependencyClosure`,
  );
  const dependencyCount =
    install.dependencyCount === undefined
      ? dependencyClosure.length
      : nonnegativeSafeInteger(install.dependencyCount, `${source}.dependencyCount`);
  if (dependencyCount !== dependencyClosure.length) {
    throw new Error(`${source}.dependencyCount must match the normalized closure length`);
  }
  return {
    durationMs: nonnegativeFiniteNumber(install.durationMs, `${source}.durationMs`),
    maxRssBytes:
      install.maxRssBytes === undefined || install.maxRssBytes === null
        ? null
        : nonnegativeSafeInteger(install.maxRssBytes, `${source}.maxRssBytes`),
    tree: normalizeTreeTotals(install.tree, `${source}.tree`),
    dependencyCount,
    dependencyClosure,
    lockfileSha256: optionalSha256(install.lockfileSha256, `${source}.lockfileSha256`),
  };
}

function normalizeTreeTotals(value, source) {
  const totals = requireRecord(value, source);
  const fileCount = nonnegativeSafeInteger(totals.fileCount, `${source}.fileCount`);
  const entryCount =
    totals.entryCount === undefined
      ? fileCount
      : nonnegativeSafeInteger(totals.entryCount, `${source}.entryCount`);
  if (entryCount < fileCount) throw new Error(`${source}.entryCount must be at least fileCount`);
  return {
    bytes: nonnegativeSafeInteger(totals.bytes, `${source}.bytes`),
    fileCount,
    entryCount,
  };
}

function normalizeStartup(value, repeats, source) {
  const startup = requireRecord(value, source);
  return Object.fromEntries(
    DISTRIBUTION_STARTUP_SCENARIOS.map((scenario) => {
      const row = requireRecord(startup[scenario], `${source}.${scenario}`);
      const summary = summarizeDurationSamples(row.samplesMs);
      if (summary.samplesMs.length !== repeats) {
        throw new Error(
          `${source}.${scenario}.samplesMs must contain exactly ${String(repeats)} values`,
        );
      }
      assertOptionalFiniteDerived(row.medianMs, summary.medianMs, `${source}.${scenario}.medianMs`);
      assertOptionalFiniteDerived(row.p95Ms, summary.p95Ms, `${source}.${scenario}.p95Ms`);
      return [scenario, summary];
    }),
  );
}

function normalizeReportLanguageFamilies(value, tarballs, source) {
  if (value === undefined) {
    return groupLanguageFamilyPackages(tarballs, zeroResolvedFamilyRows(tarballs));
  }
  if (!Array.isArray(value)) throw new TypeError(`${source} must be an array`);
  const groupCount = value.length;
  if (groupCount !== DISTRIBUTION_LANGUAGE_FAMILIES.length) {
    throw new Error(`${source} must contain exactly six canonical language groups`);
  }
  const seenLanguages = new Set();
  const resolvedRows = [];
  const canonicalPackageNames = new Set(
    tarballs
      .filter((row) => languageFamilyForPackage(row.packageName) !== undefined)
      .map((row) => row.packageName),
  );
  for (const index of numericIndices(groupCount)) {
    const rawGroup = value[index];
    const group = requireRecord(rawGroup, `${source}[${String(index)}]`);
    const language = requiredString(group.language, `${source}[${String(index)}].language`);
    if (!DISTRIBUTION_LANGUAGE_FAMILIES.includes(language)) {
      throw new Error(`${source}[${String(index)}] has unsupported language ${language}`);
    }
    if (seenLanguages.has(language))
      throw new Error(`${source} has duplicate language ${language}`);
    seenLanguages.add(language);
    if (!Array.isArray(group.packages)) {
      throw new TypeError(`${source}[${String(index)}].packages must be an array`);
    }
    const packageCount = group.packages.length;
    const expectedPackageNames = new Set(
      [...canonicalPackageNames].filter(
        (packageName) => languageFamilyForPackage(packageName) === language,
      ),
    );
    if (packageCount !== expectedPackageNames.size) {
      throw new Error(
        `${source}[${String(index)}].packages must contain exactly the canonical ${language} package rows`,
      );
    }
    appendResolvedFamilyRows(
      group.packages,
      language,
      index,
      source,
      expectedPackageNames,
      packageCount,
      resolvedRows,
    );
  }
  if (seenLanguages.size !== DISTRIBUTION_LANGUAGE_FAMILIES.length) {
    throw new Error(`${source} must contain all six canonical language groups`);
  }
  return groupLanguageFamilyPackages(tarballs, resolvedRows);
}

function appendResolvedFamilyRows(
  packages,
  language,
  groupIndex,
  source,
  expectedPackageNames,
  packageCount,
  output,
) {
  const seenPackageNames = new Set();
  for (const packageIndex of numericIndices(packageCount)) {
    const rawPackage = packages[packageIndex];
    const rowSource = `${source}[${String(groupIndex)}].packages[${String(packageIndex)}]`;
    const packageRow = requireRecord(rawPackage, rowSource);
    const packageName = requiredString(packageRow.packageName, `${rowSource}.packageName`);
    if (languageFamilyForPackage(packageName) !== language) {
      throw new Error(`${packageName} does not belong to language family ${language}`);
    }
    if (!expectedPackageNames.has(packageName)) {
      throw new Error(`${packageName} is not a canonical release package`);
    }
    if (seenPackageNames.has(packageName)) {
      throw new Error(`${packageName} is duplicated in language family ${language}`);
    }
    seenPackageNames.add(packageName);
    output.push({
      packageName,
      unpackedBytes: nonnegativeSafeInteger(packageRow.unpackedBytes, `${rowSource}.unpackedBytes`),
    });
  }
}

function zeroResolvedFamilyRows(tarballs) {
  return tarballs
    .filter((row) => languageFamilyForPackage(row.packageName) !== undefined)
    .map((row) => ({ packageName: row.packageName, unpackedBytes: 0 }));
}

function normalizeCaveats(value, source) {
  const supplied = value ?? [];
  if (!Array.isArray(supplied)) throw new TypeError(`${source} must be an array`);
  const caveatCount = supplied.length;
  if (caveatCount > DISTRIBUTION_MAX_CAVEATS) {
    throw new RangeError(
      `${source} must not contain more than ${String(DISTRIBUTION_MAX_CAVEATS)} entries`,
    );
  }
  const result = [...DISTRIBUTION_FOOTPRINT_CAVEATS];
  const seen = new Set(result);
  for (const index of numericIndices(caveatCount)) {
    const rawCaveat = supplied[index];
    const caveat = requiredString(rawCaveat, `${source}[${String(index)}]`);
    if (caveat.length > DISTRIBUTION_MAX_STRING_LENGTH) {
      throw new RangeError(`${source}[${String(index)}] is too long`);
    }
    if (!seen.has(caveat)) {
      result.push(caveat);
      seen.add(caveat);
    }
  }
  return result;
}

function assertOptionalDerivedTotal(value, expected, source) {
  if (value === undefined) return;
  const normalized = nonnegativeSafeInteger(value, source);
  if (normalized !== expected) throw new Error(`${source} does not match its package rows`);
}

function assertOptionalFiniteDerived(value, expected, source) {
  if (value === undefined) return;
  const normalized = nonnegativeFiniteNumber(value, source);
  if (normalized !== expected) throw new Error(`${source} does not match its raw samples`);
}

function numericIndices(length) {
  return Array.from({ length }, (_unused, index) => index);
}
