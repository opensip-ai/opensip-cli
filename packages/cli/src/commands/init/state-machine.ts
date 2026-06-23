/**
 * Working-directory state classification for `opensip init`.
 *
 * Decides one of four states (pristine / fully-initialized /
 * partial-config-only / partial-dir-only) based on whether the config
 * file and the user-source dir exist, and renders the partial-state
 * refusal message + the "discovered inside existing project" message.
 */

import { existsSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';

import type { InitResult, PreExistingFile } from '@opensip-cli/contracts';
import type { ProjectPaths } from '@opensip-cli/core';

export type WorkingDirState = NonNullable<InitResult['state']>;

/**
 * Classify the working directory into one of four states based on the
 * presence of the config file and the `opensip-cli/` directory.
 *
 * The dir-presence check ignores `opensip-cli/.runtime/` — that
 * subtree is tool-managed (logs, sessions, caches, plugin installs)
 * and the CLI's `preAction` hook creates `.runtime/logs/` before any
 * subcommand runs. Treating a runtime-only dir as a "partial-dir"
 * would misclassify a pristine project the moment the bootstrap hook
 * touches the disk. User-authored content lives under
 * `opensip-cli/{fit,sim}/`; only those count as "the dir is present".
 */
export function classifyWorkingDir(paths: ProjectPaths): WorkingDirState {
  const hasConfig = existsSync(paths.configFile);
  const hasDir = userSourceDirHasUserContent(paths);
  if (!hasConfig && !hasDir) return 'pristine';
  if (hasConfig && hasDir) return 'fully-initialized';
  if (hasConfig) return 'partial-config-only';
  return 'partial-dir-only';
}

function userSourceDirHasUserContent(paths: ProjectPaths): boolean {
  if (!existsSync(paths.userSourceDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(paths.userSourceDir);
  } catch {
    return false;
  }
  // Anything other than `.runtime/` (tool-managed) counts as user content.
  return entries.some((name) => name !== '.runtime');
}

function relativize(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  return rel === '' ? absPath : rel;
}

export function buildPartialStateMessage(
  state: WorkingDirState,
  preExistingFiles: readonly PreExistingFile[],
  cwd: string,
): string {
  const lines: string[] = [];
  switch (state) {
    case 'fully-initialized': {
      lines.push('OpenSIP CLI is already initialized in this directory.');
      break;
    }
    case 'partial-config-only': {
      lines.push('opensip-cli.config.yml exists but opensip-cli/ does not.');
      break;
    }
    case 'partial-dir-only': {
      lines.push('opensip-cli/ exists but opensip-cli.config.yml does not.');
      break;
    }
    case 'pristine': {
      // Should not happen in this code path — pristine never errors.
      return 'Unexpected pristine state.';
    }
  }

  if (preExistingFiles.length > 0) {
    lines.push('', `Found ${String(preExistingFiles.length)} file(s) under opensip-cli/:`);
    for (const f of preExistingFiles) {
      lines.push(`  ${relativize(f.path, cwd)}  (${f.classification})`);
    }
  }

  lines.push(
    '',
    'Choose one:',
    '  opensip init --keep    Re-scaffold examples; preserve custom files.',
    '  opensip init --remove  Delete opensip-cli/ and scaffold fresh.',
  );
  return lines.join('\n');
}

/**
 * Build the "✗ This directory is already inside an OpenSIP CLI project"
 * refusal message. Same string is embedded in the InitResult.insideExistingProject
 * for --json consumers and rendered by InitFeedback for human-readable output.
 */
export function formatInsideExistingProjectMessage(discoveredRoot: string): string {
  return [
    `✗ This directory is already inside an OpenSIP CLI project:`,
    `    ${discoveredRoot}`,
    `    (config: opensip-cli.config.yml)`,
    ``,
    `  What did you want to do?`,
    ``,
    `    • Re-scaffold examples, keep your custom files:`,
    `        opensip init --keep --cwd ${discoveredRoot}`,
    ``,
    `    • Reset the existing project (delete everything, start over):`,
    `        opensip init --remove --cwd ${discoveredRoot}`,
    ``,
    `    • Create a NEW separate project here (rare — only for`,
    `      truly independent sub-projects in a monorepo):`,
    `        opensip init --cwd .`,
  ].join('\n');
}
