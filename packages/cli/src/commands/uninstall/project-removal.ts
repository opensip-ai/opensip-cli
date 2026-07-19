/**
 * Lease-safe project removal for `opensip uninstall --project`.
 *
 * Dry-run snapshots under a short project read lease. Real deletion confirms
 * first (never holding an exclusive lease across the prompt), then acquires a
 * FIFO project exclusive lease, recollects/revalidates targets, and deletes
 * only canonical identities while held.
 *
 * Does not inspect or delete global user configuration, plugins, or update
 * state (Task 4.7 owns user-mode removal).
 */

import { resolve } from 'node:path';

import {
  acquireRuntimeExclusiveLease,
  acquireRuntimeReadLease,
  discardRuntimePromotionJournal,
  inspectEphemeralRuntimeCandidates,
  type RuntimeExclusiveLease,
  type RuntimeReadLease,
} from '@opensip-cli/core';

import {
  assertSafeProjectDir,
  buildProjectResult,
  filterProjectTargets,
  journalBlocksRemoval,
  performProjectDeletion,
  targetFingerprint,
  type ProjectJournal,
  type ProjectTargetSelection,
} from './project-removal-safety.js';
import { collectTargets, printProjectDefault, printProjectPurge } from './targets.js';

import type { UninstallDoneResult } from '@opensip-cli/contracts';

export interface ProjectRemovalOptions {
  readonly projectDir: string;
  readonly purge?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  /** High-risk break-glass: discard fixed promotion journal after purge. */
  readonly discardRecovery?: boolean;
  /** Host-owned human-presentation sink; omitted callers receive only the returned result. */
  readonly write?: (s: string) => void;
  readonly prompt?: (question: string) => Promise<string>;
  /** Test hook: inject lease acquisition. */
  readonly acquireReadLease?: (projectDir: string) => Promise<RuntimeReadLease>;
  readonly acquireExclusiveLease?: (
    projectDir: string,
    posture: 'normal' | 'destructive-discard',
  ) => Promise<RuntimeExclusiveLease>;
}

async function confirm(
  prompt: (question: string) => Promise<string>,
  message: string,
): Promise<boolean> {
  const raw = await prompt(message);
  const answer = raw.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

type ProjectWrite = NonNullable<ProjectRemovalOptions['write']>;
type ProjectPrompt = NonNullable<ProjectRemovalOptions['prompt']>;
type ProjectAcquireRead = NonNullable<ProjectRemovalOptions['acquireReadLease']>;
type ProjectAcquireExclusive = NonNullable<ProjectRemovalOptions['acquireExclusiveLease']>;

function ignorePresentation(_chunk: string): void {
  // Hostless library callers consume the returned structured result.
}

async function interactivePrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  // eslint-disable-next-line no-restricted-properties -- readline owns this interactive prompt transport; uninstall presentation still routes through the host write seam.
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

async function confirmationAccepted(
  prompt: ProjectPrompt | undefined,
  message: string,
): Promise<boolean> {
  return confirm(prompt ?? interactivePrompt, message);
}

type ProjectPreflight =
  | { readonly status: 'ready'; readonly journal: ProjectJournal }
  | { readonly status: 'done'; readonly result: UninstallDoneResult };

function preflightProjectRemoval(input: {
  readonly projectDir: string;
  readonly purge: boolean;
  readonly discardRecovery: boolean;
  readonly write: ProjectWrite;
}): ProjectPreflight {
  if (input.discardRecovery && !input.purge) {
    input.write(
      '\n--discard-recovery requires --project --purge. It is a high-risk break-glass for stuck promotion journals.\n\n',
    );
    return {
      status: 'done',
      result: buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: { status: 'refused', reason: 'discard-requires-purge' },
      }),
    };
  }

  const journal = journalBlocksRemoval(input.projectDir);
  if (journal.blocked && !input.discardRecovery) {
    input.write(
      '\nRefusing project removal while a runtime promotion journal is present.\n' +
        '  Retry interrupted Init with: opensip init\n' +
        '  High-risk break-glass (deletes runtime/cache/authored + journal): opensip uninstall --project --purge --discard-recovery\n\n',
    );
    return {
      status: 'done',
      result: buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: journal.recovery,
      }),
    };
  }
  return { status: 'ready', journal };
}

function renderProjectPreview(input: {
  readonly projectDir: string;
  readonly purge: boolean;
  readonly discardRecovery: boolean;
  readonly recoveryOnly: boolean;
  readonly selection: ProjectTargetSelection;
  readonly write: ProjectWrite;
}): void {
  if (input.recoveryOnly) {
    input.write(
      '\nNo rebuildable runtime/cache targets remain, but a promotion journal is still present.\n' +
        '  --discard-recovery will unlink only the fixed journal after exclusive confirmation.\n\n',
    );
  } else if (input.purge) {
    printProjectPurge(input.write, input.selection.toDelete, input.projectDir);
  } else {
    printProjectDefault(
      input.write,
      input.selection.toDelete,
      input.selection.toKeep,
      input.projectDir,
    );
  }

  if (input.discardRecovery) {
    input.write(
      '  ⚠ --discard-recovery will also unlink the fixed promotion journal after deleting canonical roots.\n\n',
    );
  }
}

async function executeProjectDryRun(input: {
  readonly projectDir: string;
  readonly purge: boolean;
  readonly journal: ProjectJournal;
  readonly write: ProjectWrite;
  readonly acquireRead: ProjectAcquireRead;
}): Promise<UninstallDoneResult> {
  const readLease = await input.acquireRead(input.projectDir);
  try {
    const allTargets = collectTargets('project', '', input.projectDir);
    const selection = filterProjectTargets(input.purge, allTargets);
    if (allTargets.length === 0) {
      input.write(`\nNothing to remove — no OpenSIP CLI state found at ${input.projectDir}.\n\n`);
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
      });
    }
    if (selection.toDelete.length === 0) {
      printProjectDefault(input.write, [], selection.toKeep, input.projectDir);
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
      });
    }
    if (input.purge) {
      printProjectPurge(input.write, selection.toDelete, input.projectDir);
    } else {
      printProjectDefault(input.write, selection.toDelete, selection.toKeep, input.projectDir);
    }
    return buildProjectResult({
      action: 'dry-run',
      targets: selection.toDelete,
      rootPath: input.projectDir,
      recovery: input.journal.recovery,
    });
  } finally {
    readLease.release();
  }
}

type PreparedProjectRemoval =
  | {
      readonly status: 'ready';
      readonly selection: ProjectTargetSelection;
      readonly recoveryOnly: boolean;
    }
  | { readonly status: 'done'; readonly result: UninstallDoneResult };

function prepareProjectRemoval(input: {
  readonly projectDir: string;
  readonly purge: boolean;
  readonly discardRecovery: boolean;
  readonly journal: ProjectJournal;
  readonly write: ProjectWrite;
}): PreparedProjectRemoval {
  const targets = collectTargets('project', '', input.projectDir);
  const selection = filterProjectTargets(input.purge, targets);
  const recoveryOnly =
    input.discardRecovery && input.journal.blocked && selection.toDelete.length === 0;

  if (targets.length === 0 && !recoveryOnly) {
    input.write(`\nNothing to remove — no OpenSIP CLI state found at ${input.projectDir}.\n\n`);
    return {
      status: 'done',
      result: buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: input.journal.recovery,
      }),
    };
  }
  if (selection.toDelete.length === 0 && !recoveryOnly) {
    printProjectDefault(input.write, [], selection.toKeep, input.projectDir);
    return {
      status: 'done',
      result: buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: input.journal.recovery,
      }),
    };
  }

  renderProjectPreview({ ...input, recoveryOnly, selection });
  return { status: 'ready', selection, recoveryOnly };
}

type ProjectConfirmation =
  | { readonly status: 'accepted' }
  | { readonly status: 'cancelled'; readonly result: UninstallDoneResult };

async function confirmProjectRemoval(input: {
  readonly yes: boolean;
  readonly prompt: ProjectPrompt | undefined;
  readonly projectDir: string;
  readonly journal: ProjectJournal;
  readonly selection: ProjectTargetSelection;
}): Promise<ProjectConfirmation> {
  if (input.yes || (await confirmationAccepted(input.prompt, 'Proceed? [y/N] '))) {
    return { status: 'accepted' };
  }
  return {
    status: 'cancelled',
    result: buildProjectResult({
      action: 'cancelled',
      targets: input.selection.toDelete,
      rootPath: input.projectDir,
      recovery: input.journal.recovery,
    }),
  };
}

async function executeProjectMutation(input: {
  readonly projectDir: string;
  readonly purge: boolean;
  readonly discardRecovery: boolean;
  readonly yes: boolean;
  readonly recoveryOnly: boolean;
  readonly selection: ProjectTargetSelection;
  readonly write: ProjectWrite;
  readonly acquireExclusive: ProjectAcquireExclusive;
}): Promise<UninstallDoneResult> {
  const posture = input.discardRecovery ? 'destructive-discard' : 'normal';
  const exclusive = await input.acquireExclusive(input.projectDir, posture);
  try {
    const lockedJournal = journalBlocksRemoval(input.projectDir);
    if (lockedJournal.blocked && !input.discardRecovery) {
      input.write(
        '\nRefusing project removal: a promotion journal appeared (or remains) under exclusive access.\n' +
          '  Retry interrupted Init with: opensip init\n\n',
      );
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: lockedJournal.recovery,
      });
    }

    const lockedTargets = collectTargets('project', '', input.projectDir);
    const lockedSelection = filterProjectTargets(input.purge, lockedTargets);
    const snapshotChanged =
      !input.recoveryOnly &&
      targetFingerprint(lockedSelection.toDelete) !== targetFingerprint(input.selection.toDelete);
    if (snapshotChanged && !input.yes) {
      input.write(
        '\nTarget snapshot changed while waiting for exclusive access. Re-run uninstall --project to review the new set.\n\n',
      );
      return buildProjectResult({
        action: 'cancelled',
        targets: lockedSelection.toDelete,
        rootPath: input.projectDir,
        recovery: lockedJournal.recovery,
      });
    }

    if (lockedSelection.toDelete.length === 0 && !input.discardRecovery) {
      return buildProjectResult({
        action: 'empty',
        targets: [],
        rootPath: input.projectDir,
        recovery: lockedJournal.recovery,
      });
    }
    if (lockedSelection.toDelete.length > 0) {
      performProjectDeletion(lockedSelection.toDelete, input.purge, input.projectDir);
    }

    let recovery: UninstallDoneResult['recovery'] = lockedJournal.recovery;
    if (input.discardRecovery) {
      // Cache candidates are already proven via collectTargets → inspect.
      // Never follow marker projectDir for deletion roots.
      void inspectEphemeralRuntimeCandidates(input.projectDir);
      await discardRuntimePromotionJournal(exclusive);
      recovery = { status: 'discarded' };
    }
    return buildProjectResult({
      action: 'removed',
      targets: lockedSelection.toDelete,
      rootPath: input.projectDir,
      recovery,
    });
  } finally {
    exclusive.release();
  }
}

/**
 * Project-mode uninstall: cache + project runtime (+ authored with --purge)
 * under a project exclusive lease for the mutation phase.
 */
export async function executeProjectRemoval(
  opts: ProjectRemovalOptions,
): Promise<UninstallDoneResult> {
  const projectDir = resolve(opts.projectDir);
  const write = opts.write ?? ignorePresentation;
  const purge = opts.purge === true;
  const discardRecovery = opts.discardRecovery === true;

  assertSafeProjectDir(projectDir);

  const preflight = preflightProjectRemoval({ projectDir, purge, discardRecovery, write });
  if (preflight.status === 'done') return preflight.result;
  const acquireRead =
    opts.acquireReadLease ?? ((dir: string) => acquireRuntimeReadLease({ projectDir: dir }));
  const acquireExclusive =
    opts.acquireExclusiveLease ??
    ((dir: string, posture: 'normal' | 'destructive-discard') =>
      acquireRuntimeExclusiveLease({ projectDir: dir, posture }));

  if (opts.dryRun === true) {
    return executeProjectDryRun({
      projectDir,
      purge,
      journal: preflight.journal,
      write,
      acquireRead,
    });
  }

  const prepared = prepareProjectRemoval({
    projectDir,
    purge,
    discardRecovery,
    journal: preflight.journal,
    write,
  });
  if (prepared.status === 'done') return prepared.result;

  const confirmation = await confirmProjectRemoval({
    yes: opts.yes === true,
    prompt: opts.prompt,
    projectDir,
    journal: preflight.journal,
    selection: prepared.selection,
  });
  if (confirmation.status === 'cancelled') return confirmation.result;

  return executeProjectMutation({
    projectDir,
    purge,
    discardRecovery,
    yes: opts.yes === true,
    recoveryOnly: prepared.recoveryOnly,
    selection: prepared.selection,
    write,
    acquireExclusive,
  });
}
