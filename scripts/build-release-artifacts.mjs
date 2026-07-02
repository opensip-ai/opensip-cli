#!/usr/bin/env node
//
// Generate release verification artifacts from the packed npm tarballs:
// a manifest, SHA256SUMS, and a CycloneDX SBOM for the release package set.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_ARTIFACT_GENERATOR,
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_SBOM_NAME,
  artifactEntryForFile,
  discoverTarballFiles,
  expectedTarballEntries,
  expectedTarballName,
  normalizeVersion,
  renderSha256Sums,
  sha256File,
  statArtifact,
} from './lib/release-artifacts.mjs';
import { RELEASE_PACKAGE_ORDER } from './release-package-order.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function usage() {
  return [
    'usage: node scripts/build-release-artifacts.mjs --dir <artifact-dir> --expected-version <vX.Y.Z>',
    '       [--git-tag <tag>] [--git-sha <sha>] [--sbom-file <path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dir': {
        out.artifactDir = argv[++i];
        break;
      }
      case '--expected-version': {
        out.expectedVersion = argv[++i];
        break;
      }
      case '--git-tag': {
        out.gitTag = argv[++i];
        break;
      }
      case '--git-sha': {
        out.gitSha = argv[++i];
        break;
      }
      case '--sbom-file': {
        out.sbomFile = argv[++i];
        break;
      }
      default: {
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
      }
    }
  }
  if (!out.artifactDir) throw new Error(`--dir is required\n${usage()}`);
  if (!out.expectedVersion) throw new Error(`--expected-version is required\n${usage()}`);
  return {
    artifactDir: out.artifactDir,
    expectedVersion: normalizeVersion(out.expectedVersion),
    gitTag: out.gitTag ?? `v${normalizeVersion(out.expectedVersion)}`,
    gitSha: out.gitSha ?? readGitSha(),
    sbomFile: out.sbomFile,
  };
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function componentRef(name, versionOrRange) {
  return `npm:${name}@${encodeURIComponent(versionOrRange)}`;
}

function packagePurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, unscoped] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(unscoped)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function readPackageJson(entry) {
  return JSON.parse(readFileSync(join(REPO_ROOT, entry.dir, 'package.json'), 'utf8'));
}

function addComponent(componentsByRef, component) {
  if (!componentsByRef.has(component['bom-ref'])) {
    componentsByRef.set(component['bom-ref'], component);
  }
}

function dependencyEntries(pkgJson) {
  const out = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = pkgJson[field];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, versionOrRange] of Object.entries(dependencies)) {
      if (typeof versionOrRange === 'string') out.push({ field, name, versionOrRange });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field));
}

function cyclonedxScope(field) {
  return field === 'optionalDependencies' ? 'optional' : 'required';
}

function generateCycloneDxSbom({ expectedVersion, gitTag, gitSha, now }) {
  const releaseByName = new Map(RELEASE_PACKAGE_ORDER.map((entry) => [entry.name, entry]));
  const componentsByRef = new Map();
  const dependencies = [];
  const rootRef = `opensip-cli-release@${expectedVersion}`;
  const releaseRefs = [];

  for (const entry of RELEASE_PACKAGE_ORDER) {
    const pkgJson = readPackageJson(entry);
    const packageVersion = normalizeVersion(pkgJson.version ?? expectedVersion);
    if (packageVersion !== expectedVersion) {
      throw new Error(
        `${entry.dir}/package.json version ${packageVersion} does not match ${expectedVersion}`,
      );
    }

    const ref = componentRef(entry.name, packageVersion);
    releaseRefs.push(ref);
    addComponent(componentsByRef, {
      type: entry.name === 'opensip-cli' ? 'application' : 'library',
      name: entry.name,
      version: packageVersion,
      purl: packagePurl(entry.name, packageVersion),
      'bom-ref': ref,
      properties: [
        { name: 'opensip:release:tarball', value: expectedTarballName(entry, packageVersion) },
        { name: 'opensip:release:packageDir', value: entry.dir },
      ],
    });

    const dependsOn = [];
    for (const dependency of dependencyEntries(pkgJson)) {
      const releaseDependency = releaseByName.get(dependency.name);
      const dependencyRef =
        releaseDependency === undefined
          ? componentRef(dependency.name, dependency.versionOrRange)
          : componentRef(dependency.name, expectedVersion);
      dependsOn.push(dependencyRef);
      if (releaseDependency === undefined) {
        addComponent(componentsByRef, {
          type: 'library',
          name: dependency.name,
          version: dependency.versionOrRange,
          scope: cyclonedxScope(dependency.field),
          'bom-ref': dependencyRef,
        });
      }
    }
    dependencies.push({ ref, dependsOn: [...new Set(dependsOn)].sort() });
  }

  dependencies.push({ ref: rootRef, dependsOn: releaseRefs.sort() });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:00000000-0000-4000-8000-${createDeterministicSerialSuffix(expectedVersion)}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: {
        components: [
          {
            type: 'application',
            author: 'OpenSIP CLI',
            name: 'build-release-artifacts.mjs',
            version: '1',
          },
        ],
      },
      component: {
        type: 'application',
        name: 'opensip-cli release',
        version: expectedVersion,
        'bom-ref': rootRef,
        properties: [
          { name: 'opensip:release:gitTag', value: gitTag },
          { name: 'opensip:release:gitSha', value: gitSha },
        ],
      },
    },
    components: [...componentsByRef.values()].sort((a, b) =>
      String(a['bom-ref']).localeCompare(String(b['bom-ref'])),
    ),
    dependencies: dependencies.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

function createDeterministicSerialSuffix(value) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash.toString(16).padStart(12, '0').slice(0, 12);
}

function writeSbom({ artifactDir, sbomFile, expectedVersion, gitTag, gitSha, now }) {
  const outPath = join(artifactDir, RELEASE_SBOM_NAME);
  if (sbomFile !== undefined) {
    writeFileSync(outPath, readFileSync(sbomFile));
    return outPath;
  }
  const sbom = generateCycloneDxSbom({ expectedVersion, gitTag, gitSha, now });
  writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  return outPath;
}

function assertCycloneDxSbom(sbomPath) {
  const parsed = JSON.parse(readFileSync(sbomPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || parsed.bomFormat !== 'CycloneDX') {
    throw new TypeError(`${sbomPath} is not a CycloneDX SBOM`);
  }
  if (!Array.isArray(parsed.components) && !Array.isArray(parsed.dependencies)) {
    throw new TypeError(`${sbomPath} does not contain components or dependencies`);
  }
}

function assertTarballSet(artifactDir, version) {
  const expected = new Set(expectedTarballEntries(version).map((entry) => entry.fileName));
  const actualTarballs = readdirSync(artifactDir).filter((file) => file.endsWith('.tgz'));
  const missing = [...expected].filter((file) => !existsSync(join(artifactDir, file)));
  const extra = actualTarballs.filter((file) => !expected.has(file));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...missing.map((file) => `missing ${file}`),
      ...extra.map((file) => `unexpected ${file}`),
    ];
    throw new Error(`packed tarball set does not match release order:\n${details.join('\n')}`);
  }
}

export async function buildReleaseArtifacts({
  artifactDir,
  expectedVersion,
  gitTag,
  gitSha,
  sbomFile,
  now = new Date(),
}) {
  const releaseVersion = normalizeVersion(expectedVersion);
  const releaseGitTag = gitTag ?? `v${releaseVersion}`;
  const releaseGitSha = gitSha ?? readGitSha();
  mkdirSync(artifactDir, { recursive: true });
  assertTarballSet(artifactDir, releaseVersion);

  const sbomPath = writeSbom({
    artifactDir,
    sbomFile,
    expectedVersion: releaseVersion,
    gitTag: releaseGitTag,
    gitSha: releaseGitSha,
    now,
  });
  assertCycloneDxSbom(sbomPath);

  const artifacts = [];
  for (const tarball of discoverTarballFiles(artifactDir, releaseVersion)) {
    artifacts.push(
      await artifactEntryForFile({
        artifactDir,
        fileName: tarball.fileName,
        name: tarball.fileName,
        kind: 'npm-tarball',
        packageName: tarball.packageName,
        packageVersion: releaseVersion,
      }),
    );
  }
  artifacts.push(
    await artifactEntryForFile({
      artifactDir,
      fileName: RELEASE_SBOM_NAME,
      name: RELEASE_SBOM_NAME,
      kind: 'sbom',
      format: 'cyclonedx-json',
    }),
  );

  const manifest = {
    schemaVersion: 1,
    releaseVersion,
    gitTag: releaseGitTag,
    gitSha: releaseGitSha,
    generatedAt: now.toISOString(),
    generator: RELEASE_ARTIFACT_GENERATOR,
    artifacts,
  };

  const manifestPath = join(artifactDir, RELEASE_MANIFEST_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checksumEntries = [
    ...artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    {
      path: RELEASE_MANIFEST_NAME,
      sha256: await sha256File(manifestPath),
    },
  ];
  const checksumsPath = join(artifactDir, RELEASE_CHECKSUMS_NAME);
  writeFileSync(checksumsPath, renderSha256Sums(checksumEntries), 'utf8');
  const checksumStat = await statArtifact(checksumsPath, RELEASE_CHECKSUMS_NAME);

  return {
    manifest,
    manifestPath,
    checksumsPath,
    sbomPath,
    artifactCount: artifacts.length + 2,
    checksumSizeBytes: checksumStat.sizeBytes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await buildReleaseArtifacts(parseArgs(process.argv.slice(2)));
    console.log(`[release-artifacts] manifest: ${result.manifestPath}`);
    console.log(`[release-artifacts] checksums: ${result.checksumsPath}`);
    console.log(`[release-artifacts] sbom: ${result.sbomPath}`);
    console.log(`[release-artifacts] artifacts: ${result.artifactCount}`);
  } catch (error) {
    console.error(
      `[release-artifacts] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
