import {
  buildProjectInventorySnapshotIdentities,
  projectInventorySnapshotSchema,
  PROJECT_INVENTORY_SCHEMA_VERSION,
} from '@opensip-cli/contracts';

import { byCodePoint, deepFreeze } from './freeze.js';
import { normalizeConfigIdentity } from './inventory-helpers.js';

import type { PackageManifestFacts, ProjectInventory, ProjectInventoryInput } from './types.js';
import type {
  ContextCoverage,
  FileFact,
  PackageFact,
  ProjectFact,
  ProjectInventorySnapshot,
} from '@opensip-cli/contracts';

function projectFact(
  configIdentity: string,
  manifests: readonly PackageManifestFacts[],
  packages: readonly PackageFact[],
  files: readonly FileFact[],
): ProjectFact {
  const root = manifests.find((manifest) => manifest.root === '.');
  return deepFreeze({
    ...(root?.packageManager === undefined ? {} : { packageManager: root.packageManager }),
    workspacePatterns: [...(root?.workspacePatterns ?? [])],
    languages: [...new Set(files.flatMap((file) => file.languages))].sort(byCodePoint),
    fileCount: files.length,
    packageCount: packages.length,
    configIdentity,
  });
}

function filesBoundToPackages(
  files: readonly FileFact[],
  packages: readonly PackageFact[],
): readonly FileFact[] {
  const retainedNames = new Set(packages.map((pkg) => pkg.name));
  return files.map((file) => {
    if (file.packageName === undefined || retainedNames.has(file.packageName)) return file;
    return deepFreeze({
      path: file.path,
      size: file.size,
      modifiedMs: file.modifiedMs,
      roles: file.roles,
      targets: file.targets,
      languages: file.languages,
      evidenceSupport: file.evidenceSupport,
      provenance: file.provenance,
    });
  });
}

function snapshotBase(
  configIdentity: string,
  manifests: readonly PackageManifestFacts[],
  packages: readonly PackageFact[],
  files: readonly FileFact[],
  available: boolean,
  reasons: readonly string[],
): Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'> {
  return {
    schemaVersion: PROJECT_INVENTORY_SCHEMA_VERSION,
    project: projectFact(configIdentity, manifests, packages, files),
    packages,
    files,
    coverage: coverage(files, available, reasons),
  };
}

function serializedSnapshotBytes(
  base: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'>,
  packageArrayBytes: number,
  fileArrayBytes: number,
): number {
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({
      ...base,
      packages: [],
      files: [],
      metadataIdentity: `m1:${'0'.repeat(64)}`,
      snapshotId: `i1:${'0'.repeat(64)}`,
    }),
    'utf8',
  );
  return envelopeBytes + packageArrayBytes + fileArrayBytes;
}

function jsonArrayPrefixBytes(values: readonly unknown[]): readonly number[] {
  const prefix = [0];
  let bytes = 0;
  for (const [index, value] of values.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(value), 'utf8') + (index === 0 ? 0 : 1);
    prefix.push(bytes);
  }
  return prefix;
}

function largestFittingPrefix(maximum: number, fits: (length: number) => boolean): number {
  let low = 0;
  let high = maximum;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (fits(midpoint)) low = midpoint;
    else high = midpoint - 1;
  }
  return low;
}

export function enforceSerializedBudget(input: {
  readonly configIdentity: string;
  readonly manifests: readonly PackageManifestFacts[];
  readonly packages: readonly PackageFact[];
  readonly files: readonly FileFact[];
  readonly available: boolean;
  readonly reasons: Set<string>;
  readonly maximumBytes: number;
}): {
  readonly base: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'>;
  readonly packages: readonly PackageFact[];
  readonly files: readonly FileFact[];
} {
  const full = snapshotBase(
    input.configIdentity,
    input.manifests,
    input.packages,
    input.files,
    input.available,
    [...input.reasons],
  );
  const packagePrefixBytes = jsonArrayPrefixBytes(input.packages);
  const filePrefixBytes = jsonArrayPrefixBytes(input.files);
  if (
    serializedSnapshotBytes(
      full,
      packagePrefixBytes[input.packages.length] ?? 0,
      filePrefixBytes[input.files.length] ?? 0,
    ) <= input.maximumBytes
  ) {
    return { base: full, packages: input.packages, files: input.files };
  }

  input.reasons.add('inventory-byte-cap-reached');
  const reasonCodes = [...input.reasons];
  const packageCount = largestFittingPrefix(input.packages.length, (length) => {
    const packages = input.packages.slice(0, length);
    return (
      serializedSnapshotBytes(
        snapshotBase(
          input.configIdentity,
          input.manifests,
          packages,
          [],
          input.available,
          reasonCodes,
        ),
        packagePrefixBytes[length] ?? 0,
        0,
      ) <= input.maximumBytes
    );
  });
  const packages = input.packages.slice(0, packageCount);
  const packageBoundFiles = filesBoundToPackages(input.files, packages);
  const boundedFilePrefixBytes = jsonArrayPrefixBytes(packageBoundFiles);
  const fileCount = largestFittingPrefix(packageBoundFiles.length, (length) => {
    const files = packageBoundFiles.slice(0, length);
    return (
      serializedSnapshotBytes(
        snapshotBase(
          input.configIdentity,
          input.manifests,
          packages,
          files,
          input.available,
          reasonCodes,
        ),
        packagePrefixBytes[packageCount] ?? 0,
        boundedFilePrefixBytes[length] ?? 0,
      ) <= input.maximumBytes
    );
  });
  const files = packageBoundFiles.slice(0, fileCount);
  return {
    base: snapshotBase(
      input.configIdentity,
      input.manifests,
      packages,
      files,
      input.available,
      reasonCodes,
    ),
    packages,
    files,
  };
}

function coverage(
  files: readonly FileFact[],
  available: boolean,
  reasons: readonly string[],
): ContextCoverage {
  const uniqueReasons = [...new Set(reasons)].sort(byCodePoint);
  let status: ContextCoverage['status'];
  if (available) status = uniqueReasons.length > 0 ? 'partial' : 'complete';
  else status = 'unavailable';
  return deepFreeze({
    status,
    reasonCodes: uniqueReasons,
    observed: files.length,
    ...(status === 'complete' ? { total: files.length } : {}),
  });
}

export function emptyInventory(
  input: ProjectInventoryInput,
  reasons: Set<string>,
): ProjectInventory {
  const configIdentity = normalizeConfigIdentity(input.configIdentity, reasons);
  const snapshotInput: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'> = {
    schemaVersion: PROJECT_INVENTORY_SCHEMA_VERSION,
    project: {
      workspacePatterns: [],
      languages: [],
      fileCount: 0,
      packageCount: 0,
      configIdentity,
    },
    packages: [],
    files: [],
    coverage: {
      status: 'unavailable' as const,
      reasonCodes: [...reasons].sort(byCodePoint),
      observed: 0,
    },
  };
  const identities = buildProjectInventorySnapshotIdentities(snapshotInput);
  const snapshot = deepFreeze(
    projectInventorySnapshotSchema.parse({
      ...snapshotInput,
      ...identities,
    }),
  );
  return Object.freeze({
    snapshot,
    fileByPath: new Map(),
    packageByRoot: new Map(),
    manifestByRoot: new Map(),
  });
}
