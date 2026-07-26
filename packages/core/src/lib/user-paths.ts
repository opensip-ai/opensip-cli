/**
 * User-global data and coordination path layouts.
 *
 * The coordination root deliberately remains a sibling of the removable user
 * data tree so uninstall cannot replace the mutex guarding that tree.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { SystemError } from './errors.js';

/** User-level paths in `~/.opensip-cli/`. */
export interface UserPaths {
  /** ~/.opensip-cli — root for all user-level state. */
  readonly userHomeDir: string;
  /** ~/.opensip-cli/config.yml — cloud API key + per-user defaults. */
  readonly configFile: string;
  /** ~/.opensip-cli/cache — user-level tool-generated cache state. */
  readonly cacheDir: string;
  /** ~/.opensip-cli/cache/ephemeral — no-init per-project runtime roots. */
  readonly ephemeralProjectsDir: string;
  /** User-global installed plugin directory for one capability domain. */
  readonly pluginsDir: (domain: string) => string;
  /** Global authored Tool sidecars trusted by placement in the user's home. */
  readonly authoredToolsDir: string;
  /** Tool-generated cache of the last-known newer published version. */
  readonly updateStateFile: string;
}

/** Fixed per-project Init promotion journal basename. */
export const RUNTIME_PROMOTION_JOURNAL_FILE = 'runtime-promotion.json';

/** Fixed user-uninstall recovery receipt basename. */
export const USER_UNINSTALL_RECEIPT_FILE = 'user-uninstall.json';

/** Stable paths used only for runtime coordination, never customer evidence. */
export interface CoordinationPaths {
  /** Sibling of `~/.opensip-cli`; user uninstall must never recursively remove it. */
  readonly coordinationDir: string;
  /** Short-lived global mutex used only while publishing coordination transitions. */
  readonly globalMutexFile: string;
  /** Bounded FIFO writer queue and monotonic sequence record. */
  readonly stateFile: string;
  /** Container for path-stable canonical project coordination keys. */
  readonly projectsDir: string;
  /** Shared user-state reader records. */
  readonly userReadersDir: string;
  /** Fixed external user-uninstall recovery receipt. */
  readonly userUninstallReceiptFile: string;
  /** Resolve the fixed, non-generation-bound layout for one coordination key. */
  readonly forProject: (coordinationKey: string) => {
    readonly projectCoordinationDir: string;
    readonly readersDir: string;
    readonly promotionJournalFile: string;
  };
}

/** Resolve the user-level data path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-cli');
  const cacheDir = join(userHomeDir, 'cache');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
    cacheDir,
    ephemeralProjectsDir: join(cacheDir, 'ephemeral'),
    updateStateFile: join(userHomeDir, 'update-state.json'),
    authoredToolsDir: join(userHomeDir, 'tools'),
    pluginsDir: (domain) => join(userHomeDir, 'plugins', domain),
  };
}

/**
 * Resolve the small coordination-only sibling root.
 *
 * This root lives outside `~/.opensip-cli/`: global uninstall can move or
 * remove the user-data tree, but it must not replace the mutex preventing
 * another process from entering that tree concurrently.
 */
export function resolveCoordinationPaths(): CoordinationPaths {
  const coordinationDir = join(homedir(), '.opensip-cli-coordination');
  const projectsDir = join(coordinationDir, 'projects');
  return {
    coordinationDir,
    globalMutexFile: join(coordinationDir, 'coordination.lock'),
    stateFile: join(coordinationDir, 'state.json'),
    projectsDir,
    userReadersDir: join(coordinationDir, 'user-readers'),
    userUninstallReceiptFile: join(coordinationDir, USER_UNINSTALL_RECEIPT_FILE),
    /**
     * Resolve the coordination record for a previously validated project key.
     *
     * @throws {SystemError} When the project key is not a safe lowercase-hex identity.
     */
    forProject: (coordinationKey) => {
      if (!/^[a-f0-9]{24}$/u.test(coordinationKey)) {
        throw new SystemError('Runtime coordination key is invalid', {
          code: 'CORE.RUNTIME_COORDINATION.INVALID_KEY',
        });
      }
      const projectCoordinationDir = join(projectsDir, coordinationKey);
      return {
        projectCoordinationDir,
        readersDir: join(projectCoordinationDir, 'readers'),
        promotionJournalFile: join(projectCoordinationDir, RUNTIME_PROMOTION_JOURNAL_FILE),
      };
    },
  };
}
