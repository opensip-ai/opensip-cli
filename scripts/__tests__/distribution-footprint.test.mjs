import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_FOOTPRINT_CAVEATS,
  DISTRIBUTION_FOOTPRINT_DEFAULT_OUTPUT,
  DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION,
  DISTRIBUTION_LANGUAGE_FAMILIES,
  DISTRIBUTION_MEASURE_DEFAULT_REPEATS,
  DISTRIBUTION_RELEASE_SET_MAX_COMPRESSED_BYTES,
  DISTRIBUTION_TARBALL_MAX_COMPRESSED_BYTES,
  calculateInstalledCliClosureCompressedBytes,
  collectReleaseTarballRows,
  createDistributionFootprintReport,
  groupLanguageFamilyFootprints,
  languageFamilyForPackage,
  normalizeDistributionVersion,
  normalizeDistributionFootprintReport,
  normalizeReleaseTarballRows,
  parseDistributionMeasureArgs,
  scanPhysicalTree,
  scanResolvedPackage,
  sumReleaseSetCompressedBytes,
  summarizeDurationSamples,
  validateDistributionRegistryOrigin,
} from '../lib/distribution-footprint.mjs';
import { expectedTarballEntries } from '../lib/release-artifacts.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

test('schema-v1 reports normalize required data, optional defaults, and additive fields', () => {
  const raw = minimumReport();
  raw.futureAdditiveField = { accepted: true };
  raw.environment.futureEnvironmentField = true;

  const report = normalizeDistributionFootprintReport(raw, '<fixture>');
  assert.equal(report.schemaVersion, DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION);
  assert.equal(report.environment.osRelease, '');
  assert.equal(report.release.artifactSetSha256, null);
  assert.equal(report.release.completeReleaseSetCompressedBytes, canonicalRows().length);
  assert.equal(report.release.installedCliClosureCompressedBytes, 2);
  assert.equal(report.measurement.registryOrigin, null);
  assert.equal(report.install.maxRssBytes, null);
  assert.equal(report.install.tree.entryCount, report.install.tree.fileCount);
  assert.equal(report.install.dependencyCount, 2);
  assert.equal(report.install.lockfileSha256, null);
  assert.deepEqual(report.caveats, DISTRIBUTION_FOOTPRINT_CAVEATS);
  assert.deepEqual(
    report.languageFamilies.map((entry) => entry.language),
    DISTRIBUTION_LANGUAGE_FAMILIES,
  );
  assert.equal(
    report.languageFamilies.every((entry) => entry.unpackedBytes === 0),
    true,
  );
  assert.equal('futureAdditiveField' in report, false);
  assert.deepEqual(normalizeDistributionFootprintReport(report), report);

  const withoutSchemaVersion = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'schemaVersion'),
  );
  const constructed = createDistributionFootprintReport(withoutSchemaVersion);
  assert.deepEqual(constructed, report);
});

test('schema-v1 reports reject invalid roots, required fields, versions, and derived summaries', () => {
  assert.throws(() => normalizeDistributionFootprintReport(null), /must be an object/u);
  assert.throws(
    () => normalizeDistributionFootprintReport({ schemaVersion: 2 }),
    /schemaVersion must be 1/u,
  );
  assert.throws(
    () => normalizeDistributionFootprintReport({ schemaVersion: 1 }),
    /environment must be an object/u,
  );

  for (const generatedAt of [
    '1',
    'July 13, 2026',
    '2026-07-13',
    '2026-07-13T00:00:00Z',
    '2026-07-13T00:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z',
  ]) {
    const invalidTimestamp = minimumReport();
    invalidTimestamp.generatedAt = generatedAt;
    assert.throws(
      () => normalizeDistributionFootprintReport(invalidTimestamp),
      /canonical ISO timestamp/u,
    );
  }

  const negative = minimumReport();
  negative.startup.help.samplesMs = [-1, 2];
  assert.throws(() => normalizeDistributionFootprintReport(negative), /finite and non-negative/u);

  const inconsistent = minimumReport();
  inconsistent.startup.version.medianMs = 999;
  assert.throws(() => normalizeDistributionFootprintReport(inconsistent), /raw samples/u);

  const wrongTotal = minimumReport();
  wrongTotal.release.completeReleaseSetCompressedBytes = 1;
  assert.throws(() => normalizeDistributionFootprintReport(wrongTotal), /package rows/u);

  const unexpectedFamilyPackage = minimumReport();
  unexpectedFamilyPackage.languageFamilies = groupLanguageFamilyFootprints(
    unexpectedFamilyPackage.release.tarballs,
    attributableRows(unexpectedFamilyPackage.release.tarballs),
  );
  unexpectedFamilyPackage.languageFamilies.at(-1).packages.push({
    packageName: '@opensip-cli/graph-cpp',
    compressedBytes: 1,
    unpackedBytes: 1,
  });
  assert.throws(
    () => normalizeDistributionFootprintReport(unexpectedFamilyPackage),
    /exactly the canonical cpp package rows/u,
  );

  const hostileFamilyLength = minimumReport();
  hostileFamilyLength.languageFamilies = new Proxy([], {
    get(target, property, receiver) {
      return property === 'length' ? 1_000_000 : Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => normalizeDistributionFootprintReport(hostileFamilyLength),
    /exactly six canonical language groups/u,
  );
});

test('distribution versions use the strict SemVer grammar', () => {
  for (const valid of [
    '0.0.0',
    '1.2.3',
    '1.2.3-0',
    '1.2.3-alpha.1',
    '1.2.3-001alpha',
    '1.2.3+001.sha',
    '1.2.3-alpha+build.7',
  ]) {
    assert.equal(normalizeDistributionVersion(valid), valid);
  }
  for (const invalid of [
    '1.2.3-.',
    '1.2.3-..',
    '1.2.3-alpha..beta',
    '1.2.3-01',
    '1.2.3+..',
    '01.2.3',
    '1.02.3',
    '1.2.03',
  ]) {
    assert.throws(() => normalizeDistributionVersion(invalid), /semantic version/u);
  }
});

test('duration summaries expose raw samples plus median and nearest-rank p95', () => {
  assert.deepEqual(summarizeDurationSamples([5, 1, 3, 2]), {
    samplesMs: [5, 1, 3, 2],
    medianMs: 2.5,
    p95Ms: 5,
  });
  assert.throws(() => summarizeDurationSamples([]), /non-empty/u);
  assert.throws(() => summarizeDurationSamples([Number.NaN]), /finite/u);
  assert.throws(() => summarizeDurationSamples([-0.1]), /non-negative/u);
});

test('language package mapping is exact and family grouping is deterministic', () => {
  for (const language of DISTRIBUTION_LANGUAGE_FAMILIES) {
    assert.equal(languageFamilyForPackage(`@opensip-cli/lang-${language}`), language);
    assert.equal(languageFamilyForPackage(`@opensip-cli/checks-${language}`), language);
    if (language !== 'cpp') {
      assert.equal(languageFamilyForPackage(`@opensip-cli/graph-${language}`), language);
    }
  }
  for (const shared of [
    '@opensip-cli/checks-universal',
    '@opensip-cli/graph',
    '@opensip-cli/graph-adapter-common',
    '@opensip-cli/tree-sitter',
  ]) {
    assert.equal(languageFamilyForPackage(shared), undefined);
  }

  const tarballs = canonicalRows();
  const resolvedRows = attributableRows(tarballs).toReversed();
  const grouped = groupLanguageFamilyFootprints(tarballs.toReversed(), resolvedRows);
  assert.deepEqual(
    grouped.map((entry) => entry.language),
    DISTRIBUTION_LANGUAGE_FAMILIES,
  );
  assert.deepEqual(
    grouped[0].packages.map((entry) => entry.packageName),
    [
      '@opensip-cli/lang-typescript',
      '@opensip-cli/checks-typescript',
      '@opensip-cli/graph-typescript',
    ],
  );
  assert.deepEqual(
    grouped.at(-1).packages.map((entry) => entry.packageName),
    ['@opensip-cli/lang-cpp', '@opensip-cli/checks-cpp'],
  );
  assert.equal(
    grouped.some((entry) => entry.packages.some((row) => row.packageName.endsWith('universal'))),
    false,
  );
});

test('release tarball rows require exact identities and bounded compressed inputs', () => {
  const rows = canonicalRows();
  assert.deepEqual(
    normalizeReleaseTarballRows(rows.toReversed(), VERSION).map((entry) => entry.packageName),
    rows.map((entry) => entry.packageName),
  );
  assert.equal(sumReleaseSetCompressedBytes(rows), rows.length);

  assert.throws(() => normalizeReleaseTarballRows(rows.slice(1), VERSION), /incomplete/u);
  assert.throws(
    () => normalizeReleaseTarballRows([...rows.slice(0, -1), rows[0]], VERSION),
    /duplicate/u,
  );
  assert.throws(
    () =>
      normalizeReleaseTarballRows(
        [...rows.slice(0, -1), { ...rows.at(-1), packageName: '@opensip-cli/not-released' }],
        VERSION,
      ),
    /unexpected package/u,
  );

  const overflow = canonicalRows();
  overflow[0] = { ...overflow[0], compressedBytes: Number.MAX_SAFE_INTEGER };
  assert.throws(
    () => sumReleaseSetCompressedBytes(overflow),
    new RegExp(`must not exceed ${String(DISTRIBUTION_TARBALL_MAX_COMPRESSED_BYTES)} bytes`, 'u'),
  );

  const perTarballBytes =
    Math.floor(DISTRIBUTION_RELEASE_SET_MAX_COMPRESSED_BYTES / rows.length) + 1;
  const aggregateOverflow = canonicalRows().map((row) => ({
    ...row,
    compressedBytes: perTarballBytes,
  }));
  assert.equal(
    aggregateOverflow.every(
      (row) => row.compressedBytes <= DISTRIBUTION_TARBALL_MAX_COMPRESSED_BYTES,
    ),
    true,
  );
  assert.throws(
    () => normalizeReleaseTarballRows(aggregateOverflow, VERSION),
    new RegExp(
      `aggregate compressed bytes must not exceed ${String(DISTRIBUTION_RELEASE_SET_MAX_COMPRESSED_BYTES)} bytes`,
      'u',
    ),
  );
});

test('complete tarball collection rejects missing, extra, and symlinked release artifacts', () => {
  const root = temporaryDirectory('opensip-distribution-tarballs-');
  try {
    for (const entry of expectedTarballEntries(VERSION)) {
      writeFileSync(join(root, entry.fileName), entry.packageName, 'utf8');
    }
    const rows = collectReleaseTarballRows(root, VERSION);
    assert.equal(rows.length, expectedTarballEntries(VERSION).length);
    assert.equal(
      rows.every((row) => row.compressedBytes > 0),
      true,
    );

    writeFileSync(join(root, 'opensip-cli-unexpected-0.0.0.tgz'), 'x');
    assert.throws(() => collectReleaseTarballRows(root, VERSION), /exact complete/u);
    unlinkSync(join(root, 'opensip-cli-unexpected-0.0.0.tgz'));

    const first = expectedTarballEntries(VERSION)[0];
    unlinkSync(join(root, first.fileName));
    assert.throws(() => collectReleaseTarballRows(root, VERSION), /exact complete/u);
    symlinkSync(expectedTarballEntries(VERSION)[1].fileName, join(root, first.fileName));
    assert.throws(() => collectReleaseTarballRows(root, VERSION), /regular file, not a symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed CLI closure totals include only installed canonical OpenSIP packages', () => {
  const rows = canonicalRows().map((row, index) => ({
    ...row,
    compressedBytes: index + 1,
  }));
  const byName = new Map(rows.map((row) => [row.packageName, row.compressedBytes]));
  const closure = [
    { name: 'third-party', version: '9.0.0' },
    { name: '@opensip-cli/core', version: VERSION },
    { name: 'opensip-cli', version: VERSION },
  ];
  assert.equal(
    calculateInstalledCliClosureCompressedBytes(closure, rows),
    byName.get('opensip-cli') + byName.get('@opensip-cli/core'),
  );
  assert.equal(
    calculateInstalledCliClosureCompressedBytes(closure, rows) < sumReleaseSetCompressedBytes(rows),
    true,
    'uninstalled first-party Tool tarballs must not inflate the installed closure total',
  );
  assert.throws(
    () =>
      calculateInstalledCliClosureCompressedBytes(
        [...closure, { name: '@opensip-cli/not-released', version: VERSION }],
        rows,
      ),
    /no canonical tarball row/u,
  );
  assert.throws(
    () => calculateInstalledCliClosureCompressedBytes(closure.slice(0, 2), rows),
    /include opensip-cli/u,
  );
});

test('argument parsing resolves offline defaults and enforces mode-specific inputs', () => {
  const root = temporaryDirectory('opensip-distribution-args-');
  const artifacts = join(root, 'artifacts');
  const store = join(root, 'store');
  mkdirSync(artifacts);
  mkdirSync(store);
  try {
    const offline = parseDistributionMeasureArgs(
      ['--dir', 'artifacts', '--expected-version', `v${VERSION}`, '--store-dir', 'store'],
      { cwd: root },
    );
    assert.deepEqual(offline, {
      help: false,
      artifactDir: realpathSyncPortable(artifacts),
      expectedVersion: VERSION,
      outputPath: resolve(root, DISTRIBUTION_FOOTPRINT_DEFAULT_OUTPUT),
      repeats: DISTRIBUTION_MEASURE_DEFAULT_REPEATS,
      mode: 'offline-cache',
      allowRegistry: false,
      storeDir: realpathSyncPortable(store),
    });

    const cold = parseDistributionMeasureArgs(
      [
        '--dir',
        artifacts,
        '--expected-version',
        VERSION,
        '--mode',
        'registry-cold',
        '--registry',
        'https://registry.npmjs.org/',
        '--allow-registry',
        '--repeats',
        '100',
        '--out',
        'result.json',
      ],
      { cwd: root },
    );
    assert.equal(cold.registryOrigin, 'https://registry.npmjs.org');
    assert.equal(cold.repeats, 100);
    assert.equal(cold.outputPath, join(root, 'result.json'));
    assert.deepEqual(parseDistributionMeasureArgs(['--help']), { help: true });

    assert.throws(
      () => parseDistributionMeasureArgs(['--unknown'], { cwd: root }),
      /Unknown option/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          [
            '--dir',
            artifacts,
            '--expected-version',
            VERSION,
            '--store-dir',
            store,
            '--repeats',
            '101',
          ],
          { cwd: root },
        ),
      /must not exceed 100/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          [
            '--dir',
            artifacts,
            '--expected-version',
            VERSION,
            '--store-dir',
            store,
            '--repeats',
            '1x',
          ],
          { cwd: root },
        ),
      /positive integer/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          ['--dir', artifacts, '--expected-version', '../unsafe', '--store-dir', store],
          { cwd: root },
        ),
      /semantic version/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          ['--dir', join(root, 'missing'), '--expected-version', VERSION, '--store-dir', store],
          { cwd: root },
        ),
      /existing directory/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          [
            '--dir',
            artifacts,
            '--expected-version',
            VERSION,
            '--mode',
            'registry-cold',
            '--registry',
            'https://registry.npmjs.org',
          ],
          { cwd: root },
        ),
      /allow-registry/u,
    );
    assert.throws(
      () =>
        parseDistributionMeasureArgs(
          [
            '--dir',
            artifacts,
            '--expected-version',
            VERSION,
            '--mode',
            'registry-cold',
            '--registry',
            'https://registry.npmjs.org',
            '--allow-registry',
            '--store-dir',
            store,
          ],
          { cwd: root },
        ),
      /not valid in registry-cold/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry origins reject credentials and outbound-unsafe URL shapes', () => {
  assert.equal(
    validateDistributionRegistryOrigin('https://registry.npmjs.org/'),
    'https://registry.npmjs.org',
  );
  assert.equal(
    validateDistributionRegistryOrigin('http://localhost:4873'),
    'http://localhost:4873',
  );
  assert.equal(
    validateDistributionRegistryOrigin('http://127.0.0.1:4873'),
    'http://127.0.0.1:4873',
  );
  assert.equal(validateDistributionRegistryOrigin('http://[::1]:4873'), 'http://[::1]:4873');

  for (const invalid of [
    'https://user:secret@registry.npmjs.org',
    'https://registry.npmjs.org?token=secret',
    'https://registry.npmjs.org#fragment',
    'https://registry.npmjs.org/custom/path',
    ['http:', '//registry.npmjs.org'].join(''),
    ['ftp:', '//registry.npmjs.org'].join(''),
  ]) {
    assert.throws(
      () => validateDistributionRegistryOrigin(invalid),
      /credentials|query|hash|origin|HTTPS/u,
    );
  }
});

test('physical scans count contained entries without following links and enforce bounds', async () => {
  const root = temporaryDirectory('opensip-distribution-physical-');
  try {
    await writeFile(join(root, 'a.txt'), 'abc');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'b.txt'), 'de');
    await symlink('a.txt', join(root, 'a-link'));
    const symlinkBytes = lstatSync(join(root, 'a-link')).size;

    assert.deepEqual(await scanPhysicalTree(root), {
      bytes: 5 + symlinkBytes,
      fileCount: 3,
      entryCount: 4,
    });
    await assert.rejects(() => scanPhysicalTree(root, { maxEntries: 3 }), /maximum entries 3/u);
    await assert.rejects(() => scanPhysicalTree(root, { maxDepth: 1 }), /maximum depth 1/u);
    await assert.rejects(
      () =>
        scanPhysicalTree(
          root,
          {},
          {
            opendir: async () => {
              throw new Error('unreadable fixture');
            },
          },
        ),
      /unreadable fixture/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('physical and resolved scans reject symlink escapes, cycles, and size overflow', async () => {
  const root = temporaryDirectory('opensip-distribution-hostile-tree-');
  const outside = temporaryDirectory('opensip-distribution-outside-');
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape'));
    await assert.rejects(() => scanPhysicalTree(root), /symlink escapes root/u);
    rmSync(join(root, 'escape'));
    await symlink('.', join(root, 'cycle'));
    await assert.rejects(() => scanPhysicalTree(root), /cycle detected/u);
    rmSync(join(root, 'cycle'));

    await writeFile(join(root, 'one'), '1');
    await writeFile(join(root, 'two'), '2');
    await assert.rejects(
      () =>
        scanPhysicalTree(
          root,
          {},
          {
            lstat: async (path) => {
              const info = await lstat(path);
              if (basename(path) === 'one' || basename(path) === 'two') {
                return statsWithSize(info, Number.MAX_SAFE_INTEGER);
              }
              return info;
            },
          },
        ),
      /MAX_SAFE_INTEGER/u,
    );

    const modules = join(root, 'node_modules');
    const packageDir = join(modules, '.pnpm', 'lang-python');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'index.js'), '1234');
    await mkdir(join(modules, '@opensip-cli'), { recursive: true });
    await symlink(packageDir, join(modules, '@opensip-cli', 'lang-python'));
    assert.deepEqual(await scanResolvedPackage(modules, '@opensip-cli/lang-python'), {
      packageName: '@opensip-cli/lang-python',
      unpackedBytes: 4,
      fileCount: 1,
      entryCount: 1,
    });
    await symlink('index.js', join(packageDir, 'index-alias.js'));
    assert.deepEqual(await scanResolvedPackage(modules, '@opensip-cli/lang-python'), {
      packageName: '@opensip-cli/lang-python',
      unpackedBytes: 4,
      fileCount: 1,
      entryCount: 2,
    });
    await symlink('.', join(packageDir, 'cycle'));
    await assert.rejects(
      () => scanResolvedPackage(modules, '@opensip-cli/lang-python'),
      /cycle detected/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolved package scan rejects a package-root escape and malformed package names', async () => {
  const root = temporaryDirectory('opensip-distribution-resolved-escape-');
  const outside = temporaryDirectory('opensip-distribution-resolved-outside-');
  const modules = join(root, 'node_modules');
  try {
    await mkdir(join(modules, '@opensip-cli'), { recursive: true });
    await writeFile(join(outside, 'index.js'), 'x');
    await symlink(outside, join(modules, '@opensip-cli', 'lang-go'));
    await assert.rejects(
      () => scanResolvedPackage(modules, '@opensip-cli/lang-go'),
      /escapes the supplied root/u,
    );
    await assert.rejects(
      () => scanResolvedPackage(modules, '@opensip-cli/../outside'),
      /exact @opensip-cli/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function minimumReport() {
  return {
    schemaVersion: DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION,
    generatedAt: '2026-07-13T00:00:00.000Z',
    environment: {
      nodeVersion: 'v24.0.0',
      pnpmVersion: '11.10.0',
      npmVersion: '11.0.0',
      platform: 'darwin',
      architecture: 'arm64',
    },
    release: {
      cliVersion: VERSION,
      gitSha: 'abc123',
      tarballs: canonicalRows(),
    },
    measurement: { mode: 'offline-cache', repeats: 2 },
    install: {
      durationMs: 10,
      tree: { bytes: 20, fileCount: 2 },
      dependencyClosure: [
        { name: 'opensip-cli', version: VERSION },
        { name: '@opensip-cli/core', version: VERSION },
      ],
    },
    startup: {
      version: { samplesMs: [1, 2] },
      help: { samplesMs: [2, 3] },
      initHelp: { samplesMs: [3, 4] },
    },
  };
}

function canonicalRows() {
  return expectedTarballEntries(VERSION).map((entry) => ({
    packageName: entry.packageName,
    version: VERSION,
    fileName: entry.fileName,
    compressedBytes: 1,
  }));
}

function attributableRows(tarballs) {
  return tarballs
    .filter((row) => languageFamilyForPackage(row.packageName) !== undefined)
    .map((row, index) => ({
      packageName: row.packageName,
      unpackedBytes: index + 1,
    }));
}

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function realpathSyncPortable(path) {
  return realpathSync(path);
}

function statsWithSize(info, size) {
  return new Proxy(info, {
    get(target, property, receiver) {
      return property === 'size' ? size : Reflect.get(target, property, receiver);
    },
  });
}
