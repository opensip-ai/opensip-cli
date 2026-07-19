import { basename, dirname, join } from 'node:path';

import {
  resolveCoordinationPaths,
  resolveProjectPaths,
  resolveUserPaths,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import { assertSourceMarkerAuthority } from './runtime-promotion-cache-marker-authority.js';
import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  runtimePromotionFilesystemFailure,
  type StablePromotionDirectory,
} from './runtime-promotion-filesystem-io.js';
import { assertRuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

import type {
  RuntimePromotionJournal,
  RuntimePromotionRootIdentity,
} from './runtime-promotion-journal-schema.js';
import type { RuntimePromotionDatastoreCandidate } from './runtime-promotion-preflight-datastore-types.js';
import type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';

const MAINTENANCE_LOCK_BASENAME = 'runtime-promotion-datastore.lock';

export interface BoundRuntimePromotionDatastoreCandidate {
  readonly candidate: RuntimePromotionDatastoreCandidate;
  readonly runtimeRoot: StablePromotionDirectory;
  readonly ancestors: readonly StablePromotionDirectory[];
  readonly databasePath: string;
  readonly assertAdditionalAuthority?: () => void;
}

export interface BoundRuntimePromotionDatastoreSet {
  readonly candidates: readonly BoundRuntimePromotionDatastoreCandidate[];
  readonly coordinationRoot: StablePromotionDirectory;
  readonly coordinationAncestors: readonly StablePromotionDirectory[];
  readonly lockPath: string;
  readonly directoryDependencies: RuntimePromotionDatastoreDirectoryDependencies;
}

export interface RuntimePromotionDatastoreDirectoryDependencies {
  readonly openStableDirectory: typeof openStablePromotionDirectory;
  readonly assertStableDirectory: typeof assertStablePromotionDirectory;
  readonly closeStableDirectory: typeof closeStablePromotionDirectory;
}

const DEFAULT_DIRECTORY_DEPENDENCIES: RuntimePromotionDatastoreDirectoryDependencies =
  Object.freeze({
    openStableDirectory: openStablePromotionDirectory,
    assertStableDirectory: assertStablePromotionDirectory,
    closeStableDirectory: closeStablePromotionDirectory,
  });

function sameAuthorityIdentity(
  directory: StablePromotionDirectory,
  authority: RuntimePromotionProjectRootAuthority,
): boolean {
  return (
    directory.path === authority.projectRoot &&
    directory.identity.dev.toString() === authority.identity.dev &&
    directory.identity.ino.toString() === authority.identity.ino &&
    directory.identity.uid.toString() === authority.identity.uid &&
    directory.identity.mode.toString() === authority.identity.mode
  );
}

function openExactChild(
  parent: StablePromotionDirectory,
  path: string,
  expectedBasename: string,
  description: string,
  dependencies: RuntimePromotionDatastoreDirectoryDependencies,
): StablePromotionDirectory {
  const child = dependencies.openStableDirectory(path, description);
  let transferred = false;
  try {
    if (dirname(child.path) !== parent.path || basename(child.path) !== expectedBasename) {
      runtimePromotionFilesystemFailure(`${description} is outside its authoritative parent`);
    }
    dependencies.assertStableDirectory(parent, `${description} parent`);
    dependencies.assertStableDirectory(child, description);
    transferred = true;
    return child;
  } finally {
    if (!transferred) dependencies.closeStableDirectory(child);
  }
}

function assertJournalRootIdentity(
  directory: StablePromotionDirectory,
  expected: RuntimePromotionRootIdentity | null,
  description: string,
): void {
  if (
    directory.identity.dev.toString() !== expected?.device ||
    directory.identity.ino.toString() !== expected?.inode
  ) {
    runtimePromotionFilesystemFailure(`${description} was replaced after journal creation`);
  }
}

function bindSource(
  candidate: RuntimePromotionDatastoreCandidate,
  journal: RuntimePromotionJournal,
  authority: RuntimePromotionProjectRootAuthority,
  dependencies: RuntimePromotionDatastoreDirectoryDependencies,
): BoundRuntimePromotionDatastoreCandidate {
  const cacheKey = journal.source.cacheKey;
  if (candidate.kind !== 'source' || cacheKey === null) {
    runtimePromotionFilesystemFailure('the datastore source lacks journal authority');
  }
  const cacheRoot = dependencies.openStableDirectory(
    resolveUserPaths().ephemeralProjectsDir,
    'the ephemeral cache root',
  );
  let runtimeRoot: StablePromotionDirectory | undefined;
  try {
    runtimeRoot = openExactChild(
      cacheRoot,
      candidate.runtimeDir,
      cacheKey,
      'the selected cache runtime',
      dependencies,
    );
    const boundRuntimeRoot = runtimeRoot;
    const assertSourceAuthority = (): void => {
      assertJournalRootIdentity(
        boundRuntimeRoot,
        journal.source.rootIdentity,
        'the selected cache runtime',
      );
      assertSourceMarkerAuthority(boundRuntimeRoot.path, cacheRoot.path, journal, authority);
    };
    assertSourceAuthority();
    return {
      candidate,
      runtimeRoot: boundRuntimeRoot,
      ancestors: [cacheRoot],
      databasePath: join(boundRuntimeRoot.path, 'datastore.sqlite'),
      assertAdditionalAuthority: assertSourceAuthority,
    };
  } catch (error) {
    if (runtimeRoot !== undefined) dependencies.closeStableDirectory(runtimeRoot);
    dependencies.closeStableDirectory(cacheRoot);
    throw error;
  }
}

function bindProjectCandidate(
  candidate: Extract<RuntimePromotionDatastoreCandidate, { readonly kind: 'destination' }>,
  journal: RuntimePromotionJournal,
  authority: RuntimePromotionProjectRootAuthority,
  dependencies: RuntimePromotionDatastoreDirectoryDependencies,
): BoundRuntimePromotionDatastoreCandidate {
  if (!journal.destinationRuntimePreexisting) {
    runtimePromotionFilesystemFailure(
      'the datastore destination lacks preexisting journal authority',
    );
  }
  const project = dependencies.openStableDirectory(
    authority.projectRoot,
    'the promotion project root',
  );
  let authoredRoot: StablePromotionDirectory | undefined;
  let runtimeRoot: StablePromotionDirectory | undefined;
  try {
    if (!sameAuthorityIdentity(project, authority)) {
      runtimePromotionFilesystemFailure(
        'the datastore project root does not match attempt-local authority',
      );
    }
    const projectPaths = resolveProjectPaths(authority.projectRoot);
    authoredRoot = openExactChild(
      project,
      projectPaths.userSourceDir,
      'opensip-cli',
      'the project-authored root',
      dependencies,
    );
    runtimeRoot = openExactChild(
      authoredRoot,
      candidate.runtimeDir,
      '.runtime',
      'the project runtime',
      dependencies,
    );
    const boundRuntimeRoot = runtimeRoot;
    const assertDestinationAuthority = (): void =>
      assertJournalRootIdentity(
        boundRuntimeRoot,
        journal.destinationRootIdentity,
        'the project runtime',
      );
    assertDestinationAuthority();
    return {
      candidate,
      runtimeRoot: boundRuntimeRoot,
      ancestors: [project, authoredRoot],
      databasePath: join(boundRuntimeRoot.path, 'datastore.sqlite'),
      assertAdditionalAuthority: assertDestinationAuthority,
    };
  } catch (error) {
    if (runtimeRoot !== undefined) dependencies.closeStableDirectory(runtimeRoot);
    if (authoredRoot !== undefined) dependencies.closeStableDirectory(authoredRoot);
    dependencies.closeStableDirectory(project);
    throw error;
  }
}

function closeCandidate(
  candidate: BoundRuntimePromotionDatastoreCandidate,
  dependencies: RuntimePromotionDatastoreDirectoryDependencies,
): void {
  dependencies.closeStableDirectory(candidate.runtimeRoot);
  for (let index = candidate.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = candidate.ancestors[index];
    if (ancestor !== undefined) dependencies.closeStableDirectory(ancestor);
  }
}

function closeCandidates(
  candidates: readonly BoundRuntimePromotionDatastoreCandidate[],
  dependencies: RuntimePromotionDatastoreDirectoryDependencies,
): void {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate !== undefined) closeCandidate(candidate, dependencies);
  }
}

export function closeBoundRuntimePromotionDatastoreSet(
  bound: BoundRuntimePromotionDatastoreSet,
): void {
  const dependencies = bound.directoryDependencies;
  closeCandidates(bound.candidates, dependencies);
  dependencies.closeStableDirectory(bound.coordinationRoot);
  for (let index = bound.coordinationAncestors.length - 1; index >= 0; index -= 1) {
    const ancestor = bound.coordinationAncestors[index];
    if (ancestor !== undefined) dependencies.closeStableDirectory(ancestor);
  }
}

export function bindRuntimePromotionDatastoreSet(
  input: {
    readonly candidates: readonly RuntimePromotionDatastoreCandidate[];
    readonly journal: RuntimePromotionJournal;
    readonly lease: RuntimeExclusiveLease;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  },
  dependencyOverrides: Partial<RuntimePromotionDatastoreDirectoryDependencies> = {},
): BoundRuntimePromotionDatastoreSet {
  const dependencies = {
    ...DEFAULT_DIRECTORY_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const boundCandidates: BoundRuntimePromotionDatastoreCandidate[] = [];
  const coordinationAncestors: StablePromotionDirectory[] = [];
  let coordinationRoot: StablePromotionDirectory | undefined;
  try {
    for (const candidate of input.candidates) {
      boundCandidates.push(
        candidate.kind === 'source'
          ? bindSource(candidate, input.journal, input.projectRootAuthority, dependencies)
          : bindProjectCandidate(
              candidate,
              input.journal,
              input.projectRootAuthority,
              dependencies,
            ),
      );
    }
    const coordinationPaths = resolveCoordinationPaths();
    const coordinationAnchor = dependencies.openStableDirectory(
      coordinationPaths.coordinationDir,
      'the runtime coordination anchor',
    );
    coordinationAncestors.push(coordinationAnchor);
    const projectsRoot = openExactChild(
      coordinationAnchor,
      coordinationPaths.projectsDir,
      'projects',
      'the runtime coordination projects root',
      dependencies,
    );
    coordinationAncestors.push(projectsRoot);
    const coordinationPath = coordinationPaths.forProject(
      input.projectRootAuthority.coordinationKey,
    ).projectCoordinationDir;
    coordinationRoot = openExactChild(
      projectsRoot,
      coordinationPath,
      input.projectRootAuthority.coordinationKey,
      'the promotion coordination root',
      dependencies,
    );
    const result = {
      candidates: boundCandidates,
      coordinationRoot,
      coordinationAncestors,
      lockPath: join(coordinationRoot.path, MAINTENANCE_LOCK_BASENAME),
      directoryDependencies: dependencies,
    };
    assertBoundRuntimePromotionDatastoreSet(input, result);
    return result;
  } catch (error) {
    closeCandidates(boundCandidates, dependencies);
    if (coordinationRoot !== undefined) dependencies.closeStableDirectory(coordinationRoot);
    for (let index = coordinationAncestors.length - 1; index >= 0; index -= 1) {
      const ancestor = coordinationAncestors[index];
      if (ancestor !== undefined) dependencies.closeStableDirectory(ancestor);
    }
    throw error;
  }
}

export function assertBoundRuntimePromotionDatastoreSet(
  input: {
    readonly lease: RuntimeExclusiveLease;
    readonly projectRootAuthority: RuntimePromotionProjectRootAuthority;
  },
  bound: BoundRuntimePromotionDatastoreSet,
): void {
  assertRuntimePromotionProjectRootAuthority({
    lease: input.lease,
    authority: input.projectRootAuthority,
  });
  const dependencies = bound.directoryDependencies;
  for (const ancestor of bound.coordinationAncestors) {
    dependencies.assertStableDirectory(ancestor, 'a promotion coordination ancestor');
  }
  dependencies.assertStableDirectory(bound.coordinationRoot, 'the promotion coordination root');
  for (const candidate of bound.candidates) {
    for (const ancestor of candidate.ancestors) {
      dependencies.assertStableDirectory(ancestor, 'a datastore authority ancestor');
    }
    dependencies.assertStableDirectory(candidate.runtimeRoot, 'an authoritative runtime root');
    candidate.assertAdditionalAuthority?.();
  }
}
