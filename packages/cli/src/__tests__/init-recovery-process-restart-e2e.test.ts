/**
 * Requires a built CLI. Stages a complete canonical Init journal under one
 * process/lease, releases that authority to model process death, and proves a
 * new `opensip init` process converges the operation and unlinks the journal.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireRuntimeExclusiveLease, resolveCoordinationPaths } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  bindAuthoredStateReceipt,
  commitAuthoredState,
  prepareAuthoredState,
  verifyAuthoredState,
} from '../commands/init/authored-state-transaction.js';
import { createInitAuthoredPlan } from '../commands/init/init-authored-plan.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  parseRuntimePromotionJournal,
} from '../commands/init/runtime-promotion-journal-schema.js';
import { createRuntimePromotionJournalController } from '../commands/init/runtime-promotion-journal.js';
import { captureRuntimePromotionProjectRootAuthority } from '../commands/init/runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from '../commands/init/runtime-promotion-transitions.js';

const CLI_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

async function stageCanonicalPreparedJournal(project: string): Promise<string> {
  const plan = createInitAuthoredPlan({
    projectRoot: project,
    languages: ['typescript'],
    mode: 'fresh',
    toolScaffolds: [],
  });
  const lease = await acquireRuntimeExclusiveLease({
    projectDir: project,
    posture: 'normal',
    command: 'stage process-restart Init recovery',
    cwdBasename: basename(project),
  });
  try {
    const controller = createRuntimePromotionJournalController(lease);
    const allocation = controller.allocate((identity) =>
      createInitialRuntimePromotionJournal({
        coordinationKey: lease.coordinationKey,
        operationId: identity.operationId,
        recoveryOwnerToken: identity.recoveryOwnerToken,
        route: 'authored-only',
        destinationParentPreexisting: false,
        destinationRuntimePreexisting: false,
        destinationRootIdentity: null,
        source: {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        },
        inputs: {
          conflict: 'abort',
          authoredMode: plan.inputs.mode,
          languages: plan.inputs.languages,
          languageExplicit: false,
        },
        plan: {
          authoredDigest: plan.digest,
          replayDigest: plan.replayManifestDigest,
          mutationCount: plan.mutations.length,
        },
        owned: createRuntimePromotionOwnedSlots(identity.operationId),
        createdAt: identity.createdAt,
      }),
    );
    await controller.create(allocation);
    return resolveCoordinationPaths().forProject(lease.coordinationKey).promotionJournalFile;
  } finally {
    lease.release();
  }
}

async function stageCanonicalAuthoredCommittedJournal(project: string): Promise<{
  readonly journalFile: string;
  readonly authoredArtifactBasenames: readonly string[];
}> {
  const plan = createInitAuthoredPlan({
    projectRoot: project,
    languages: ['typescript'],
    mode: 'fresh',
    toolScaffolds: [],
  });
  const lease = await acquireRuntimeExclusiveLease({
    projectDir: project,
    posture: 'normal',
    command: 'stage forward process-restart Init recovery',
    cwdBasename: basename(project),
  });
  try {
    const projectRootAuthority = captureRuntimePromotionProjectRootAuthority({
      lease,
      projectRoot: project,
      expectedPosture: 'normal',
    });
    const controller = createRuntimePromotionJournalController(lease);
    const writer = createRuntimePromotionTransitionWriter(controller);
    const allocation = controller.allocate((identity) =>
      createInitialRuntimePromotionJournal({
        coordinationKey: lease.coordinationKey,
        operationId: identity.operationId,
        recoveryOwnerToken: identity.recoveryOwnerToken,
        route: 'authored-only',
        destinationParentPreexisting: false,
        destinationRuntimePreexisting: false,
        destinationRootIdentity: null,
        source: {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        },
        inputs: {
          conflict: 'abort',
          authoredMode: plan.inputs.mode,
          languages: plan.inputs.languages,
          languageExplicit: false,
        },
        plan: {
          authoredDigest: plan.digest,
          replayDigest: plan.replayManifestDigest,
          mutationCount: plan.mutations.length,
        },
        owned: createRuntimePromotionOwnedSlots(identity.operationId),
        createdAt: identity.createdAt,
      }),
    );
    let receipt = await controller.create(allocation);
    const prepared = await prepareAuthoredState({
      projectRoot: project,
      projectRootAuthority,
      lease,
      controller,
      receipt,
      plan,
    });
    receipt = await writer.bindAuthoredPrepared(prepared.receipt);
    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    const committed = await commitAuthoredState(prepared.transaction);
    receipt = await writer.bindAuthoredCommitted(committed.receipt);
    await bindAuthoredStateReceipt(prepared.transaction, receipt);
    const verified = await verifyAuthoredState(prepared.transaction, 'desired');
    if (!verified.verified) throw new Error('staged authored state was not verified');
    const journal = await controller.verifyOpen(receipt);
    return {
      journalFile: resolveCoordinationPaths().forProject(lease.coordinationKey)
        .promotionJournalFile,
      authoredArtifactBasenames: [
        journal.owned.authoredStage.basename,
        journal.owned.authoredBackup.basename,
        journal.owned.replayManifest.basename,
      ],
    };
  } finally {
    lease.release();
  }
}

describe('Init process-restart recovery', () => {
  it('claims a complete open journal in a new process, converges it, and unlinks it', async () => {
    const previousHome = process.env.HOME;
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-init-restart-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-init-restart-project-')));
    process.env.HOME = home;

    try {
      const journalFile = await stageCanonicalPreparedJournal(project);
      const staged = parseRuntimePromotionJournal(readFileSync(journalFile, 'utf8'), {
        state: 'open',
      });
      expect(staged).toMatchObject({
        state: 'open',
        revision: 0,
        route: 'authored-only',
        progress: {
          phase: 'prepared',
          direction: 'forward',
          pendingIntent: null,
        },
        terminal: null,
      });
      expect(staged.plan.mutationCount).toBeGreaterThan(0);

      const result = spawnSync(process.execPath, [CLI_DIST, 'init', '--json', '--cwd', project], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(home, 'xdg-cache'),
          XDG_CONFIG_HOME: join(home, 'xdg-config'),
          NO_COLOR: '1',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const outcome = JSON.parse(result.stdout) as {
        readonly kind: string;
        readonly status: string;
        readonly exitCode: number;
        readonly data: {
          readonly type: string;
          readonly created: boolean;
          readonly runtimeAdoption?: {
            readonly status: string;
            readonly sourcePreserved?: boolean;
            readonly sourceRetired?: boolean;
            readonly reasonCode?: string;
            readonly nextCommand?: string;
          };
        };
      };
      expect(outcome).toMatchObject({
        kind: 'init',
        status: 'ok',
        exitCode: 1,
        data: {
          type: 'init',
          created: false,
          runtimeAdoption: {
            status: 'rolled-back',
            sourcePreserved: false,
            sourceRetired: false,
            reasonCode: 'operation-failed',
            nextCommand: 'opensip init',
          },
        },
      });
      expect(existsSync(journalFile)).toBe(false);
      expect(existsSync(join(project, 'opensip-cli.config.yml'))).toBe(false);
      expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it('commits a durable forward operation in a new process with its original Init projection', async () => {
    const previousHome = process.env.HOME;
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-init-forward-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-init-forward-project-')));
    process.env.HOME = home;

    try {
      const staged = await stageCanonicalAuthoredCommittedJournal(project);
      const journal = parseRuntimePromotionJournal(readFileSync(staged.journalFile, 'utf8'), {
        state: 'open',
      });
      expect(journal).toMatchObject({
        state: 'open',
        route: 'authored-only',
        inputs: {
          authoredMode: 'fresh',
          languages: ['typescript'],
          languageExplicit: false,
        },
        progress: {
          phase: 'authored-committed',
          direction: 'forward',
          pendingIntent: null,
        },
        terminal: null,
      });
      expect(journal.progress.authoredCursor).toBe(journal.plan.mutationCount);
      for (const basenameValue of staged.authoredArtifactBasenames) {
        expect(existsSync(join(project, basenameValue))).toBe(true);
      }

      const result = spawnSync(process.execPath, [CLI_DIST, 'init', '--json', '--cwd', project], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(home, 'xdg-cache'),
          XDG_CONFIG_HOME: join(home, 'xdg-config'),
          NO_COLOR: '1',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const outcome = JSON.parse(result.stdout) as {
        readonly kind: string;
        readonly status: string;
        readonly exitCode: number;
        readonly data: {
          readonly type: string;
          readonly created: boolean;
          readonly refreshed?: boolean;
          readonly state?: string;
          readonly languages?: readonly string[];
          readonly runtimeAdoption?: {
            readonly status: string;
            readonly sourcePreserved?: boolean;
            readonly reasonCode?: string;
          };
        };
      };
      expect(outcome.data).not.toHaveProperty('refreshed');
      expect(existsSync(staged.journalFile)).toBe(false);
      for (const basenameValue of staged.authoredArtifactBasenames) {
        expect(existsSync(join(project, basenameValue))).toBe(false);
      }
      expect(existsSync(join(project, 'opensip-cli.config.yml'))).toBe(true);
      // This harness records no Tool scaffold contributions, so the durable
      // authored plan has no reason to create the optional user-source tree.
      expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
      expect(outcome).toMatchObject({
        kind: 'init',
        status: 'ok',
        exitCode: 0,
        data: {
          type: 'init',
          created: true,
          state: 'pristine',
          languages: ['typescript'],
          runtimeAdoption: {
            status: 'not-found',
            sourcePreserved: false,
            reasonCode: 'source-absent',
          },
        },
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});
