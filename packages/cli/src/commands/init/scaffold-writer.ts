/**
 * Disk-write phase for `opensip init`.
 *
 * Writes the config + example files, optionally preserving pre-existing
 * custom/stale-scaffolded files (`--keep`) or wiping the user-source
 * dir first (`--remove`). Also patches `.gitignore` to exclude the
 * runtime state subtree.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { resolveEphemeralProjectPaths } from '@opensip-cli/core';

import { ensureOpenSipAgentGuidance } from './agents-md.js';
import { generateConfig } from './config-templates.js';

import type { SupportedLanguage } from './language-detection.js';
import type { WorkingDirState } from './state-machine.js';
import type { ToolScaffold } from '../shared.js';
import type { InitResult, PreExistingFile } from '@opensip-cli/contracts';
import type { ProjectPaths, ScaffoldContext } from '@opensip-cli/core';

const GITIGNORE_LINE = 'opensip-cli/.runtime/';

export function ensureGitignore(cwd: string): boolean {
  const path = join(cwd, '.gitignore');
  if (!existsSync(path)) {
    writeFileSync(path, `${GITIGNORE_LINE}\n`, 'utf8');
    return true;
  }

  const content = readFileSync(path, 'utf8');
  if (content.split('\n').some((line) => line.trim() === GITIGNORE_LINE)) {
    return false; // already present, idempotent
  }

  const sep = content.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${content}${sep}\n# opensip-cli runtime state\n${GITIGNORE_LINE}\n`, 'utf8');
  return true;
}

/**
 * Write `content` to `filePath` according to the scaffold rules:
 *   - keepCustom = false → always overwrite (or create) the file.
 *   - keepCustom = true  → preserve any pre-existing file we classified
 *                          as 'custom' or 'stale-scaffolded'; overwrite
 *                          'scaffolded' files (and create missing ones).
 */
function writeScaffoldedFile(
  filePath: string,
  content: string,
  keepCustom: boolean,
  preExistingByPath: ReadonlyMap<string, PreExistingFile>,
  createdFiles: string[],
): void {
  if (keepCustom) {
    const existing = preExistingByPath.get(filePath);
    // Preserve user content. Stale-scaffolded is also preserved — the
    // user may have been working with it; we surface it but don't
    // overwrite.
    if (
      existing &&
      (existing.classification === 'custom' || existing.classification === 'stale-scaffolded')
    ) {
      return;
    }
  }
  writeFileSync(filePath, content, 'utf8');
  createdFiles.push(filePath);
}

interface ScaffoldOptions {
  /** When true, preserve files classified as 'custom' / 'stale-scaffolded'. */
  readonly keepCustom: boolean;
  /** Files that existed before scaffolding ran, indexed by absolute path. */
  readonly preExistingByPath: ReadonlyMap<string, PreExistingFile>;
}

/**
 * ADR-0038: generic, registry-driven scaffold. For each registered tool's
 * contribution: `mkdir` every `userSubdirs` kind under its `pluginLayout.domain`,
 * then write each `ScaffoldFile` the tool's `scaffoldExamples(ctx)` returns under
 * `userPluginDir(domain, file.kind)/file.filename`. No fit/sim/checks/recipes
 * literals — the directory layout comes from each tool's `pluginLayout`, the
 * example bytes from the tool (ADR-0009 corollary 1).
 */
function scaffoldToolExamples(
  paths: ProjectPaths,
  toolScaffolds: readonly ToolScaffold[],
  ctx: ScaffoldContext,
  options: ScaffoldOptions,
  createdFiles: string[],
): void {
  for (const ts of toolScaffolds) {
    if (!ts.scaffoldExamples) continue;
    for (const kind of ts.layout.userSubdirs) {
      mkdirSync(paths.userPluginDir(ts.layout.domain, kind), {
        recursive: true,
      });
    }
    for (const file of ts.scaffoldExamples(ctx)) {
      writeScaffoldedFile(
        join(paths.userPluginDir(ts.layout.domain, file.kind), file.filename),
        file.content,
        options.keepCustom,
        options.preExistingByPath,
        createdFiles,
      );
    }
  }
}

export interface ScaffoldRunInputs {
  readonly paths: ProjectPaths;
  readonly languages: SupportedLanguage[];
  readonly cwd: string;
  readonly state: WorkingDirState;
  readonly preExistingFiles: readonly PreExistingFile[];
  readonly removeFirst: boolean;
  readonly keepCustom: boolean;
  /** Per-tool scaffold contributions (ADR-0038) — the directory layout + example bytes. */
  readonly toolScaffolds: readonly ToolScaffold[];
}

export interface RefreshRunInputs {
  readonly languages?: readonly SupportedLanguage[];
  readonly cwd: string;
  readonly state: Extract<WorkingDirState, 'fully-initialized' | 'partial-config-only'>;
  readonly preExistingFiles: readonly PreExistingFile[];
  readonly toolScaffolds: readonly ToolScaffold[];
}

function agentsMdWasCreated(agentGuidance: ReturnType<typeof ensureOpenSipAgentGuidance>): boolean {
  return agentGuidance.targets.some(
    (target) => target.action === 'created' && basename(target.path) === 'AGENTS.md',
  );
}

function migrateEphemeralRuntime(paths: ProjectPaths): void {
  const source = resolveEphemeralProjectPaths(paths.projectDir).runtimeDir;
  if (!existsSync(source) || existsSync(paths.runtimeDir)) return;

  mkdirSync(paths.userSourceDir, { recursive: true });
  try {
    renameSync(source, paths.runtimeDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
    cpSync(source, paths.runtimeDir, { recursive: true, errorOnExist: true });
    rmSync(source, { recursive: true, force: true });
  }
}

export function runRefresh(
  inputs: RefreshRunInputs,
  baseResult: Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>,
): InitResult {
  const { cwd, state, languages, preExistingFiles, toolScaffolds } = inputs;
  const gitignoreUpdated = ensureGitignore(cwd);
  const agentGuidance = ensureOpenSipAgentGuidance(cwd, { toolScaffolds });

  return {
    ...baseResult,
    created: false,
    refreshed: true,
    state,
    ...(languages === undefined ? {} : { languages }),
    createdFiles: [],
    gitignoreUpdated,
    agentGuidance,
    agentsMdCreated: agentsMdWasCreated(agentGuidance),
    preExistingFiles,
  };
}

export function runScaffold(
  inputs: ScaffoldRunInputs,
  baseResult: Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>,
): InitResult {
  const { paths, languages, cwd, state, preExistingFiles, removeFirst, keepCustom, toolScaffolds } =
    inputs;

  // --remove: blow away the user-source dir before scaffolding. The
  // config file is always rewritten below regardless.
  if (removeFirst && existsSync(paths.userSourceDir)) {
    rmSync(paths.userSourceDir, { recursive: true, force: true });
  }

  const createdFiles: string[] = [];

  // Config is authoritative project state. `--keep` fills missing scaffold
  // pieces without rewriting an existing config; `--remove` and pristine init
  // still write the generated config intentionally.
  if (!keepCustom || !existsSync(paths.configFile)) {
    writeFileSync(paths.configFile, generateConfig(languages, toolScaffolds), 'utf8');
    createdFiles.push(paths.configFile);
  }

  // After --remove the dir is gone, so nothing pre-existed; pass an
  // empty map so writeScaffoldedFile creates everything fresh.
  const preExistingByPath = removeFirst
    ? new Map<string, PreExistingFile>()
    : new Map<string, PreExistingFile>(preExistingFiles.map((f) => [f.path, f]));

  const ctx: ScaffoldContext = { languages };
  scaffoldToolExamples(paths, toolScaffolds, ctx, { keepCustom, preExistingByPath }, createdFiles);

  const gitignoreUpdated = ensureGitignore(cwd);
  const agentGuidance = ensureOpenSipAgentGuidance(cwd, { toolScaffolds });
  migrateEphemeralRuntime(paths);

  return {
    ...baseResult,
    created: true,
    state,
    languages,
    createdFiles,
    gitignoreUpdated,
    agentGuidance,
    agentsMdCreated: agentsMdWasCreated(agentGuidance),
    preExistingFiles: state === 'pristine' ? [] : preExistingFiles,
  };
}
