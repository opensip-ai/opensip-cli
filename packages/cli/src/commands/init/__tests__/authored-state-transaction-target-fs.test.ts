import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileAuthoredMutation } from '../authored-state-transaction-execution.js';
import { openStableAuthoredRoot } from '../authored-state-transaction-fs.js';
import { withBoundAuthoredTarget } from '../authored-state-transaction-target-fs.js';
import { applyAuthoredDirectory } from '../authored-state-transaction-target-mutations.js';
import { directoryDigest, sha256Bytes } from '../init-authored-plan-types.js';

import type {
  AuthoredTargetMutationHooks,
  AuthoredTargetMutationOperation,
} from '../authored-state-transaction-target-fs.js';
import type { AuthoredArtifactPaths } from '../authored-state-transaction-types.js';
import type { InitAuthoredMutation, InitAuthoredPathState } from '../init-authored-plan.js';

interface TargetHarness {
  readonly sandbox: string;
  readonly project: string;
  readonly paths: AuthoredArtifactPaths;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function mkdirSafe(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function capabilityError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function targetHarness(): TargetHarness {
  const created = mkdtempSync(join(tmpdir(), 'opensip-authored-target-fs-'));
  chmodSync(created, 0o700);
  const sandbox = realpathSync(created);
  sandboxes.push(sandbox);
  const project = join(sandbox, 'project');
  const stageRoot = join(project, '.opensip-init-authored-stage-test-authority');
  const backupRoot = join(project, '.opensip-init-authored-backup-test-authority');
  mkdirSafe(join(stageRoot, 'desired'));
  mkdirSafe(join(backupRoot, 'preimage'));
  return {
    sandbox,
    project,
    paths: {
      projectRoot: project,
      stageRoot,
      backupRoot,
      replayManifest: join(project, '.opensip-init-replay-test-authority.json'),
    },
  };
}

function absent(): InitAuthoredPathState {
  return { exists: false, type: null, mode: null, digest: null };
}

function fileState(content: string, mode = 0o600): InitAuthoredPathState {
  return {
    exists: true,
    type: 'file',
    mode,
    digest: sha256Bytes(content),
  };
}

function directoryState(mode = 0o700): InitAuthoredPathState {
  return {
    exists: true,
    type: 'directory',
    mode,
    digest: directoryDigest(mode),
  };
}

function actionFor(
  preimage: InitAuthoredPathState,
  desired: InitAuthoredPathState,
): InitAuthoredMutation['action'] {
  if (!preimage.exists && desired.exists) return 'create';
  if (preimage.exists && !desired.exists) return 'delete';
  return 'replace';
}

function mutation(
  path: string,
  preimage: InitAuthoredPathState,
  desired: InitAuthoredPathState,
): InitAuthoredMutation {
  const target = desired.exists ? desired : preimage;
  if (!target.exists || target.type === null || target.mode === null) {
    throw new Error('test mutation requires one existing endpoint');
  }
  return {
    sequence: 0,
    action: actionFor(preimage, desired),
    path,
    targetType: target.type,
    targetMode: target.mode,
    preimage,
    desired,
    desiredBlob: desired.exists && desired.type === 'file' ? 'desired/0000.blob' : null,
    preimageBlob: preimage.exists && preimage.type === 'file' ? 'preimage/0000.blob' : null,
  };
}

function writeMutationBlobs(
  paths: AuthoredArtifactPaths,
  authoredMutation: InitAuthoredMutation,
  preimageContent?: string,
  desiredContent?: string,
): void {
  if (authoredMutation.preimageBlob !== null) {
    if (preimageContent === undefined) throw new Error('missing test preimage content');
    writeFileSync(join(paths.backupRoot, authoredMutation.preimageBlob), preimageContent, {
      mode: authoredMutation.preimage.mode ?? 0o600,
    });
  }
  if (authoredMutation.desiredBlob !== null) {
    if (desiredContent === undefined) throw new Error('missing test desired content');
    writeFileSync(join(paths.stageRoot, authoredMutation.desiredBlob), desiredContent, {
      mode: authoredMutation.desired.mode ?? 0o600,
    });
  }
}

function hookAt(
  expected: AuthoredTargetMutationOperation,
  callback: () => void,
): AuthoredTargetMutationHooks {
  let invoked = false;
  return {
    beforeFinalMutation: (operation) => {
      if (invoked || operation !== expected) return;
      invoked = true;
      callback();
    },
  };
}

function commit(
  harness: TargetHarness,
  authoredMutation: InitAuthoredMutation,
  hooks: AuthoredTargetMutationHooks,
): 'applied' | 'already-satisfied' {
  return reconcileAuthoredMutation(
    openStableAuthoredRoot(harness.project),
    authoredMutation,
    harness.paths,
    'commit',
    true,
    hooks,
  );
}

function fileTemporaryPath(harness: TargetHarness, authoredMutation: InitAuthoredMutation): string {
  const digest = createHash('sha256')
    .update('opensip:init-authored-target-temporary:v1')
    .update('\0')
    .update(basename(harness.paths.stageRoot))
    .update('\0')
    .update(authoredMutation.path)
    .digest('hex');
  return join(harness.project, `.opensip-init-authored-target-${digest}.tmp`);
}

describe('authored target mutation filesystem authority', () => {
  it('creates a directory through the narrow Windows target and parent handle fallback', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'windows-created-directory');
    let directoryOpenAttempts = 0;

    withBoundAuthoredTarget(
      openStableAuthoredRoot(harness.project),
      'windows-created-directory',
      (authority, current) => {
        expect(current).toEqual(absent());
        applyAuthoredDirectory(authority, 0o755);
      },
      {
        platform: 'win32',
        open: (path, flags) => {
          if ((flags & constants.O_DIRECTORY) !== 0) {
            directoryOpenAttempts += 1;
            throw capabilityError('EINVAL');
          }
          return openSync(path, flags);
        },
      },
    );

    expect(directoryOpenAttempts).toBeGreaterThanOrEqual(3);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(Number(lstatSync(target, { bigint: true }).mode & 0o777n)).toBe(0o755);
  });

  it('falls back from Windows directory fchmod and fsync while preserving identity', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'windows-existing-directory');
    mkdirSafe(target, 0o700);
    let pathChmodCalls = 0;
    let descriptorFsyncCalls = 0;

    withBoundAuthoredTarget(
      openStableAuthoredRoot(harness.project),
      'windows-existing-directory',
      (authority) => {
        applyAuthoredDirectory(authority, 0o755);
      },
      {
        platform: 'win32',
        fchmodDirectory: () => {
          throw capabilityError('EPERM');
        },
        chmodDirectoryPath: (path, mode) => {
          pathChmodCalls += 1;
          chmodSync(path, mode);
        },
        fsyncDirectoryDescriptor: () => {
          descriptorFsyncCalls += 1;
          throw capabilityError('ENOTSUP');
        },
      },
    );

    expect(pathChmodCalls).toBe(1);
    expect(descriptorFsyncCalls).toBe(1);
    expect(Number(lstatSync(target, { bigint: true }).mode & 0o777n)).toBe(0o755);
  });

  it('keeps regular authored files fail-closed when Windows open reports a capability error', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'windows-file.txt');
    writeFileSync(target, 'customer', { mode: 0o600 });
    let callbackCalled = false;

    expect(() =>
      withBoundAuthoredTarget(
        openStableAuthoredRoot(harness.project),
        'windows-file.txt',
        () => {
          callbackCalled = true;
        },
        {
          platform: 'win32',
          open: (path, flags) => {
            if ((flags & constants.O_DIRECTORY) !== 0) return openSync(path, flags);
            throw capabilityError('EINVAL');
          },
        },
      ),
    ).toThrow(/target could not be pinned/iu);

    expect(callbackCalled).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('customer');
  });

  it('rejects a parent replacement during Windows directory-open fallback', () => {
    const harness = targetHarness();
    const parent = join(harness.project, 'windows-parent');
    const displaced = join(harness.project, 'windows-parent.displaced');
    mkdirSafe(parent);

    expect(() =>
      withBoundAuthoredTarget(
        openStableAuthoredRoot(harness.project),
        'windows-parent/target',
        () => {
          throw new Error('callback must not run');
        },
        {
          platform: 'win32',
          open: (path, flags) => {
            if (path === parent && (flags & constants.O_DIRECTORY) !== 0) {
              renameSync(parent, displaced);
              mkdirSafe(parent);
              throw capabilityError('EINVAL');
            }
            return openSync(path, flags);
          },
        },
      ),
    ).toThrow(/parent changed during Windows handle fallback/iu);

    expect(lstatSync(parent).isDirectory()).toBe(true);
    expect(lstatSync(displaced).isDirectory()).toBe(true);
  });

  it('rejects a directory replacement during the Windows path-chmod fallback', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'windows-path-chmod');
    const displaced = join(harness.project, 'windows-path-chmod.displaced');
    mkdirSafe(target, 0o700);

    expect(() =>
      withBoundAuthoredTarget(
        openStableAuthoredRoot(harness.project),
        'windows-path-chmod',
        (authority) => {
          applyAuthoredDirectory(authority, 0o755);
        },
        {
          platform: 'win32',
          open: (path, flags) => {
            if (path === target && (flags & constants.O_DIRECTORY) !== 0) {
              throw capabilityError('EINVAL');
            }
            return openSync(path, flags);
          },
          chmodDirectoryPath: (path, mode) => {
            renameSync(path, displaced);
            mkdirSafe(path, mode);
          },
        },
      ),
    ).toThrow(/was replaced/iu);

    expect(Number(lstatSync(displaced, { bigint: true }).mode & 0o777n)).toBe(0o700);
    expect(Number(lstatSync(target, { bigint: true }).mode & 0o777n)).toBe(0o755);
  });

  it('rejects a parent replacement during Windows directory-fsync fallback', () => {
    const harness = targetHarness();
    const parent = join(harness.project, 'windows-fsync-parent');
    const displaced = join(harness.project, 'windows-fsync-parent.displaced');
    mkdirSafe(parent);
    let fsyncCalls = 0;

    expect(() =>
      withBoundAuthoredTarget(
        openStableAuthoredRoot(harness.project),
        'windows-fsync-parent/created',
        (authority) => {
          applyAuthoredDirectory(authority, 0o755);
        },
        {
          platform: 'win32',
          fsyncDirectoryDescriptor: (descriptor) => {
            fsyncCalls += 1;
            if (fsyncCalls === 1) {
              fsyncSync(descriptor);
              return;
            }
            renameSync(parent, displaced);
            mkdirSafe(parent);
            throw capabilityError('EPERM');
          },
        },
      ),
    ).toThrow(/ancestor changed before mutation/iu);

    expect(fsyncCalls).toBe(2);
    expect(lstatSync(join(displaced, 'created')).isDirectory()).toBe(true);
    expect(lstatSync(parent).isDirectory()).toBe(true);
  });

  it('does not overwrite a file injected into an absent create target', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'created.txt');
    const authoredMutation = mutation('created.txt', absent(), fileState('opensip'));
    writeMutationBlobs(harness.paths, authoredMutation, undefined, 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          writeFileSync(target, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/appeared before mutation/iu);

    expect(readFileSync(target, 'utf8')).toBe('customer');
  });

  it('does not overwrite a replacement file swapped in before commit', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'replaced.txt');
    const displaced = join(harness.project, 'replaced.txt.customer-original');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation('replaced.txt', fileState('old'), fileState('opensip'));
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          renameSync(target, displaced);
          writeFileSync(target, 'customer-replacement', { mode: 0o600 });
        }),
      ),
    ).toThrow(/target changed before mutation/iu);

    expect(readFileSync(target, 'utf8')).toBe('customer-replacement');
    expect(readFileSync(displaced, 'utf8')).toBe('old');
  });

  it('does not unlink a replacement file swapped in before delete', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'deleted.txt');
    const displaced = join(harness.project, 'deleted.txt.customer-original');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation('deleted.txt', fileState('old'), absent());
    writeMutationBlobs(harness.paths, authoredMutation, 'old');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('remove-file', () => {
          renameSync(target, displaced);
          writeFileSync(target, 'customer-replacement', { mode: 0o600 });
        }),
      ),
    ).toThrow(/target changed before mutation/iu);

    expect(readFileSync(target, 'utf8')).toBe('customer-replacement');
    expect(readFileSync(displaced, 'utf8')).toBe('old');
  });

  it('does not adopt or chmod a directory injected into an absent create target', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'created-directory');
    const sentinel = join(target, 'customer.txt');
    const authoredMutation = mutation('created-directory', absent(), directoryState(0o755));

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('create-directory', () => {
          mkdirSafe(target, 0o700);
          writeFileSync(sentinel, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/appeared before mutation/iu);

    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(Number(lstatSync(target, { bigint: true }).mode & 0o777n)).toBe(0o700);
  });

  it('does not chmod a replacement directory swapped in before mode commit', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'mode-directory');
    const displaced = join(harness.project, 'mode-directory.customer-original');
    const sentinel = join(target, 'customer.txt');
    mkdirSafe(target, 0o700);
    const authoredMutation = mutation(
      'mode-directory',
      directoryState(0o700),
      directoryState(0o755),
    );

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('chmod-directory', () => {
          renameSync(target, displaced);
          mkdirSafe(target, 0o700);
          writeFileSync(sentinel, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/target changed before mutation/iu);

    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(Number(lstatSync(target, { bigint: true }).mode & 0o777n)).toBe(0o700);
    expect(Number(lstatSync(displaced, { bigint: true }).mode & 0o777n)).toBe(0o700);
  });

  it('does not remove a replacement directory swapped in before delete', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'deleted-directory');
    const displaced = join(harness.project, 'deleted-directory.customer-original');
    const sentinel = join(target, 'customer.txt');
    mkdirSafe(target);
    const authoredMutation = mutation('deleted-directory', directoryState(), absent());

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('remove-directory', () => {
          renameSync(target, displaced);
          mkdirSafe(target);
          writeFileSync(sentinel, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/target changed before mutation/iu);

    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(lstatSync(displaced).isDirectory()).toBe(true);
  });

  it('does not escape through an ancestor swapped to an external symlink', () => {
    const harness = targetHarness();
    const parent = join(harness.project, 'nested');
    const displacedParent = join(harness.project, 'nested.customer-original');
    const target = join(parent, 'target.txt');
    const external = join(harness.sandbox, 'external');
    const externalTarget = join(external, 'target.txt');
    const externalSentinel = join(external, 'sentinel.txt');
    mkdirSafe(parent);
    mkdirSafe(external);
    writeFileSync(target, 'old', { mode: 0o600 });
    writeFileSync(externalTarget, 'external', { mode: 0o600 });
    writeFileSync(externalSentinel, 'customer', { mode: 0o600 });
    const authoredMutation = mutation('nested/target.txt', fileState('old'), fileState('opensip'));
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          renameSync(parent, displacedParent);
          symlinkSync(external, parent);
        }),
      ),
    ).toThrow(/ancestor is no longer a real directory/iu);

    expect(readFileSync(externalTarget, 'utf8')).toBe('external');
    expect(readFileSync(externalSentinel, 'utf8')).toBe('customer');
    expect(readFileSync(join(displacedParent, 'target.txt'), 'utf8')).toBe('old');
  });

  it('does not mutate through an ancestor replaced by another real directory', () => {
    const harness = targetHarness();
    const parent = join(harness.project, 'nested');
    const displacedParent = join(harness.project, 'nested.customer-original');
    const target = join(parent, 'target.txt');
    const sentinel = join(parent, 'customer.txt');
    mkdirSafe(parent);
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation('nested/target.txt', fileState('old'), fileState('opensip'));
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          renameSync(parent, displacedParent);
          mkdirSafe(parent);
          writeFileSync(target, 'customer-replacement', { mode: 0o600 });
          writeFileSync(sentinel, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/ancestor changed before mutation/iu);

    expect(readFileSync(target, 'utf8')).toBe('customer-replacement');
    expect(readFileSync(sentinel, 'utf8')).toBe('customer');
    expect(readFileSync(join(displacedParent, 'target.txt'), 'utf8')).toBe('old');
  });

  it('resumes from an exact same-parent replacement temporary', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'resumed.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation('resumed.txt', fileState('old'), fileState('opensip'));
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(harness, authoredMutation, {
        beforeFinalMutation: (operation) => {
          if (operation === 'commit-file') throw new Error('simulated target crash');
        },
      }),
    ).toThrow(/simulated target crash/iu);
    expect(readFileSync(target, 'utf8')).toBe('old');

    expect(commit(harness, authoredMutation, {})).toBe('applied');
    expect(readFileSync(target, 'utf8')).toBe('opensip');
  });

  it('does not overwrite a regular file injected at the replacement temporary path', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'temporary-collision.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation(
      'temporary-collision.txt',
      fileState('old'),
      fileState('opensip'),
    );
    const temporary = fileTemporaryPath(harness, authoredMutation);
    const blob = join(harness.paths.stageRoot, authoredMutation.desiredBlob ?? '');
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('stage-file-temporary', () => {
          writeFileSync(temporary, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/temporary appeared before mutation/iu);

    expect(readFileSync(temporary, 'utf8')).toBe('customer');
    expect(readFileSync(blob, 'utf8')).toBe('opensip');
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('does not follow a symlink injected at the replacement temporary path', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'temporary-symlink.txt');
    const external = join(harness.sandbox, 'external-sentinel.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    writeFileSync(external, 'customer', { mode: 0o600 });
    const authoredMutation = mutation(
      'temporary-symlink.txt',
      fileState('old'),
      fileState('opensip'),
    );
    const temporary = fileTemporaryPath(harness, authoredMutation);
    const blob = join(harness.paths.stageRoot, authoredMutation.desiredBlob ?? '');
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('stage-file-temporary', () => {
          symlinkSync(external, temporary);
        }),
      ),
    ).toThrow(/temporary appeared before mutation/iu);

    expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, 'utf8')).toBe('customer');
    expect(readFileSync(blob, 'utf8')).toBe('opensip');
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('removes the exact pending temporary when the target is already satisfied', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'externally-satisfied.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation(
      'externally-satisfied.txt',
      fileState('old'),
      fileState('opensip'),
    );
    const temporary = fileTemporaryPath(harness, authoredMutation);
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          throw new Error('simulated target crash');
        }),
      ),
    ).toThrow(/simulated target crash/iu);
    expect(readFileSync(temporary, 'utf8')).toBe('opensip');

    writeFileSync(target, 'opensip', { mode: 0o600 });
    expect(commit(harness, authoredMutation, {})).toBe('already-satisfied');

    expect(() => lstatSync(temporary)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('opensip');
  });

  it('preserves a replacement swapped in for a satisfied-target temporary', () => {
    const harness = targetHarness();
    const target = join(harness.project, 'satisfied-temporary-swap.txt');
    writeFileSync(target, 'old', { mode: 0o600 });
    const authoredMutation = mutation(
      'satisfied-temporary-swap.txt',
      fileState('old'),
      fileState('opensip'),
    );
    const temporary = fileTemporaryPath(harness, authoredMutation);
    const displaced = `${temporary}.opensip-original`;
    writeMutationBlobs(harness.paths, authoredMutation, 'old', 'opensip');

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('commit-file', () => {
          throw new Error('simulated target crash');
        }),
      ),
    ).toThrow(/simulated target crash/iu);
    writeFileSync(target, 'opensip', { mode: 0o600 });

    expect(() =>
      commit(
        harness,
        authoredMutation,
        hookAt('remove-satisfied-file-temporary', () => {
          renameSync(temporary, displaced);
          writeFileSync(temporary, 'customer', { mode: 0o600 });
        }),
      ),
    ).toThrow(/temporary changed while it was being removed/iu);

    expect(readFileSync(temporary, 'utf8')).toBe('customer');
    expect(readFileSync(displaced, 'utf8')).toBe('opensip');
    expect(readFileSync(target, 'utf8')).toBe('opensip');
  });
});
