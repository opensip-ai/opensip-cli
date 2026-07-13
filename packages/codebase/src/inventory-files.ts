import { statSync } from 'node:fs';

import { tryCatch } from '@opensip-cli/core';

import { classifyFileRoles } from './file-roles.js';
import { byCodePoint, deepFreeze } from './freeze.js';
import {
  compareBoundedTargets,
  type BoundedTarget,
  type FileDiscovery,
  type PendingFile,
} from './inventory-file-model.js';
import { INVENTORY_BATCH_SIZE, cancelled, yieldToEventLoop } from './inventory-helpers.js';
import { discoverStructuralFiles } from './inventory-structural.js';
import { resolveTargetFiles } from './inventory-targets.js';
import { MAX_FILE_LANGUAGES, MAX_PROJECT_LANGUAGES } from './types.js';

import type { InventoryLimits, PackageManifestFacts, ProjectInventoryInput } from './types.js';
import type {
  EvidenceReadSupportStatus,
  FactProvenance,
  FileEvidenceSupport,
  FileFact,
  FileRole,
  PackageFact,
} from '@opensip-cli/contracts';

const UNKNOWN_EVIDENCE_SUPPORT: FileEvidenceSupport = deepFreeze({
  callable: 'unknown',
  declaration: 'unknown',
  reference: 'unknown',
});

function owningPackage(path: string, packages: readonly PackageFact[]): PackageFact | undefined {
  let owner: PackageFact | undefined;
  let ownerLength = -1;
  for (const candidate of packages) {
    const root = candidate.root;
    const matches = root === '.' || path === root || path.startsWith(`${root}/`);
    if (matches && root.length > ownerLength) {
      owner = candidate;
      ownerLength = root.length;
    }
  }
  return owner;
}

function supportStatus(
  languages: readonly string[],
  input: ProjectInventoryInput,
  field: keyof FileEvidenceSupport,
): EvidenceReadSupportStatus {
  if (languages.length === 0) return 'unknown';
  const statuses = languages.map(
    (language) => input.languageEvidenceSupport?.get(language)?.[field],
  );
  if (statuses.includes('supported')) return 'supported';
  if (statuses.every((status) => status === 'unsupported')) return 'unsupported';
  return 'unknown';
}

function fileEvidenceSupport(
  languages: readonly string[],
  input: ProjectInventoryInput,
): FileEvidenceSupport {
  if (languages.length === 0 || input.languageEvidenceSupport === undefined) {
    return UNKNOWN_EVIDENCE_SUPPORT;
  }
  return deepFreeze({
    callable: supportStatus(languages, input, 'callable'),
    declaration: supportStatus(languages, input, 'declaration'),
    reference: supportStatus(languages, input, 'reference'),
  });
}

function fileLanguages(targets: readonly BoundedTarget[], reasons: Set<string>): readonly string[] {
  const languages = [...new Set(targets.flatMap((target) => target.languages))].sort(byCodePoint);
  if (languages.length > MAX_FILE_LANGUAGES) reasons.add('file-language-cap-reached');
  return languages.slice(0, MAX_FILE_LANGUAGES);
}

async function materializeFiles(
  pending: readonly PendingFile[],
  packages: readonly PackageFact[],
  input: ProjectInventoryInput,
  reasons: Set<string>,
): Promise<readonly FileFact[]> {
  const files: FileFact[] = [];
  for (const [index, candidate] of pending.entries()) {
    if (index > 0 && index % INVENTORY_BATCH_SIZE === 0) await yieldToEventLoop();
    if (cancelled(input.signal, reasons)) break;
    const fact = materializeFile(candidate, packages, input, reasons);
    if (fact !== undefined) files.push(fact);
  }
  return files.sort((left, right) => byCodePoint(left.path, right.path));
}

function materializeFile(
  candidate: PendingFile,
  packages: readonly PackageFact[],
  input: ProjectInventoryInput,
  reasons: Set<string>,
): FileFact | undefined {
  const metadata = tryCatch(() => statSync(candidate.absolutePath));
  if (!metadata.ok) {
    reasons.add('file-metadata-read-failed');
    return undefined;
  }
  if (!metadata.value.isFile()) {
    reasons.add('file-not-regular');
    return undefined;
  }
  const modifiedMs = Math.trunc(metadata.value.mtimeMs);
  if (!nonnegativeSafeInteger(metadata.value.size) || !nonnegativeSafeInteger(modifiedMs)) {
    reasons.add('file-metadata-invalid');
    return undefined;
  }
  const targets = [...candidate.targets].sort(compareBoundedTargets);
  const classification =
    targets.length === 0 && candidate.structuralRoles !== undefined
      ? { roles: [], provenance: [] }
      : classifyFileRoles(
          candidate.relativePath,
          targets.map((target) => target.view),
        );
  const roles = new Set<FileRole>([...(candidate.structuralRoles ?? []), ...classification.roles]);
  if (roles.size > 1) roles.delete('unknown');
  const provenanceByIdentity = new Map<string, FactProvenance>();
  for (const provenance of [
    ...(candidate.structuralProvenance ?? []),
    ...classification.provenance,
    deepFreeze({ source: 'filesystem' as const, detail: 'stat-metadata' }),
  ]) {
    provenanceByIdentity.set(`${provenance.source}:${provenance.detail}`, provenance);
  }
  const provenance = [...provenanceByIdentity.values()].sort((left, right) =>
    byCodePoint(`${left.source}:${left.detail}`, `${right.source}:${right.detail}`),
  );
  const owner = owningPackage(candidate.relativePath, packages);
  const languages = fileLanguages(targets, reasons);
  return deepFreeze({
    path: candidate.relativePath,
    size: metadata.value.size,
    modifiedMs,
    roles: [...roles].sort(byCodePoint),
    targets: targets.map((target) => target.name),
    languages,
    evidenceSupport: fileEvidenceSupport(languages, input),
    ...(owner === undefined ? {} : { packageName: owner.name }),
    provenance,
  });
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function discoverFiles(
  projectRoot: string,
  input: ProjectInventoryInput,
  limits: InventoryLimits,
  packages: readonly PackageFact[],
  manifests: readonly PackageManifestFacts[],
): Promise<FileDiscovery> {
  const structural = discoverStructuralFiles(projectRoot, manifests, input, limits);
  await yieldToEventLoop();
  const resolution = await resolveTargetFiles(projectRoot, input, limits, structural.pending);
  const reasons = new Set([...structural.reasons, ...resolution.reasons]);
  const files = await materializeFiles(resolution.pending, packages, input, reasons);
  return deepFreeze({
    files,
    reasons: [...reasons].sort(byCodePoint),
    available: resolution.available,
  });
}

export function boundProjectLanguages(
  files: readonly FileFact[],
  input: ProjectInventoryInput,
  reasons: Set<string>,
): readonly FileFact[] {
  const allLanguages = [...new Set(files.flatMap((file) => file.languages))].sort(byCodePoint);
  if (allLanguages.length <= MAX_PROJECT_LANGUAGES) return files;
  reasons.add('project-language-cap-reached');
  const retained = new Set(allLanguages.slice(0, MAX_PROJECT_LANGUAGES));
  return files.map((file) => {
    const languages = file.languages.filter((language) => retained.has(language));
    return deepFreeze({
      ...file,
      languages,
      evidenceSupport: fileEvidenceSupport(languages, input),
    });
  });
}
