#!/usr/bin/env node
/**
 * sync-pnpm-injection-if-needed — repair stale injected workspace copies after
 * a local one-pass build.
 *
 * `injectWorkspacePackages: true` gives the dogfood discovery walker real
 * package copies under node_modules/.pnpm, but Turbo cache hits can skip the
 * package lifecycle scripts that pnpm uses to re-sync injected deps after
 * `build`. When that happens, the source package has fresh dist files while the
 * injected copy does not, and CLI plugin loading fails from node_modules.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatContentFailures, verifyInjectedContent } from './verify-pnpm-injection.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const log = (message) => console.error(`[sync-pnpm-injection] ${message}`);

function verificationOptions(repoRoot) {
  return {
    repoRoot,
    pnpmDir: join(repoRoot, 'node_modules', '.pnpm'),
    packagesDir: join(repoRoot, 'packages'),
  };
}

/**
 * Ensure pnpm's injected workspace copies match the current workspace source.
 *
 * @param {{
 *   repoRoot?: string;
 *   run?: typeof execFileSync;
 *   verify?: typeof verifyInjectedContent;
 *   logger?: (message: string) => void;
 * }} [options]
 */
export function syncPnpmInjectionIfNeeded(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const run = options.run ?? execFileSync;
  const verify = options.verify ?? verifyInjectedContent;
  const logger = options.logger ?? log;
  const check = () => verify(verificationOptions(repoRoot));

  const before = check();
  if (before.issuesByPkg.size === 0) {
    logger(`OK — ${before.checked} injected packages match source`);
    return { checked: before.checked, synced: false };
  }

  for (const line of formatContentFailures(before.issuesByPkg)) {
    logger(line);
  }
  logger('Refreshing injected workspace copies from built workspace packages...');

  rmSync(join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true });
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' });

  const after = check();
  if (after.issuesByPkg.size > 0) {
    for (const line of formatContentFailures(after.issuesByPkg)) {
      logger(line);
    }
    throw new Error('Injected workspace copies are still stale after pnpm install');
  }

  logger(`OK — refreshed injected workspace copies; ${after.checked} packages match source`);
  return { checked: after.checked, synced: true };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  syncPnpmInjectionIfNeeded();
}
