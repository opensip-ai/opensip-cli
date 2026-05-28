/**
 * Disk-write phase for `opensip-tools init`.
 *
 * Writes the config + example files, optionally preserving pre-existing
 * custom/stale-scaffolded files (`--keep`) or wiping the user-source
 * dir first (`--remove`). Also patches `.gitignore` to exclude the
 * runtime state subtree.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  exampleCheckSource,
  exampleRecipeSource,
  exampleScenarioSource,
  exampleSimRecipeSource,
  generateConfig,
} from './config-templates.js';

import type { SupportedLanguage } from './language-detection.js';
import type { WorkingDirState } from './state-machine.js';
import type { InitResult, PreExistingFile } from '@opensip-tools/contracts';
import type { ProjectPaths } from '@opensip-tools/core';

const GITIGNORE_LINE = 'opensip-tools/.runtime/';

function ensureGitignore(cwd: string): boolean {
  const path = join(cwd, '.gitignore');
  if (!existsSync(path)) {
    writeFileSync(path, `${GITIGNORE_LINE}\n`, 'utf8');
    return true;
  }

  const content = readFileSync(path, 'utf8');
  // @fitness-ignore-next-line silent-early-returns -- idempotent "did I modify?" return: boolean IS the function's contract (caller dispatches on "already present" vs "I appended")
  if (content.split('\n').some((line) => line.trim() === GITIGNORE_LINE)) {
    return false; // already present, idempotent
  }

  const sep = content.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${content}${sep}\n# opensip-tools runtime state\n${GITIGNORE_LINE}\n`, 'utf8');
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
    if (existing && (existing.classification === 'custom' || existing.classification === 'stale-scaffolded')) {
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

function scaffoldFitChecks(
  paths: ProjectPaths,
  languages: SupportedLanguage[],
  options: ScaffoldOptions,
  createdFiles: string[],
): void {
  mkdirSync(paths.fitChecksDir, { recursive: true });
  if (languages.length === 1) {
    writeScaffoldedFile(
      join(paths.fitChecksDir, 'example-check.mjs'),
      exampleCheckSource(languages[0] ?? 'typescript'),
      options.keepCustom,
      options.preExistingByPath,
      createdFiles,
    );
    return;
  }
  // Polyglot: one example per language so each is independently editable / deletable.
  for (const lang of languages) {
    writeScaffoldedFile(
      join(paths.fitChecksDir, `example-check-${lang}.mjs`),
      exampleCheckSource(lang, lang),
      options.keepCustom,
      options.preExistingByPath,
      createdFiles,
    );
  }
}

function scaffoldExamples(
  paths: ProjectPaths,
  languages: SupportedLanguage[],
  options: ScaffoldOptions,
  createdFiles: string[],
): void {
  scaffoldFitChecks(paths, languages, options, createdFiles);

  mkdirSync(paths.fitRecipesDir, { recursive: true });
  const slugs = languages.length === 1
    ? ['example-check']
    : languages.map((lang) => `example-check-${lang}`);
  writeScaffoldedFile(
    join(paths.fitRecipesDir, 'example-recipe.mjs'),
    exampleRecipeSource(slugs),
    options.keepCustom,
    options.preExistingByPath,
    createdFiles,
  );

  mkdirSync(paths.simScenariosDir, { recursive: true });
  writeScaffoldedFile(
    join(paths.simScenariosDir, 'example-scenario.mjs'),
    exampleScenarioSource(),
    options.keepCustom,
    options.preExistingByPath,
    createdFiles,
  );

  mkdirSync(paths.simRecipesDir, { recursive: true });
  writeScaffoldedFile(
    join(paths.simRecipesDir, 'example-recipe.mjs'),
    exampleSimRecipeSource(),
    options.keepCustom,
    options.preExistingByPath,
    createdFiles,
  );
}

export interface ScaffoldRunInputs {
  readonly paths: ProjectPaths;
  readonly languages: SupportedLanguage[];
  readonly cwd: string;
  readonly state: WorkingDirState;
  readonly preExistingFiles: readonly PreExistingFile[];
  readonly removeFirst: boolean;
  readonly keepCustom: boolean;
}

export function runScaffold(
  inputs: ScaffoldRunInputs,
  baseResult: Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>,
): InitResult {
  const { paths, languages, cwd, state, preExistingFiles, removeFirst, keepCustom } = inputs;

  // --remove: blow away the user-source dir before scaffolding. The
  // config file is always rewritten below regardless.
  if (removeFirst && existsSync(paths.userSourceDir)) {
    rmSync(paths.userSourceDir, { recursive: true, force: true });
  }

  const createdFiles: string[] = [];

  // Always rewrite the config — its content is a function of the
  // selected languages, and a re-init with new --language values must
  // refresh it. (The legacy code rewrote it unconditionally on --force
  // too; we keep that semantics.)
  writeFileSync(paths.configFile, generateConfig(languages), 'utf8');
  createdFiles.push(paths.configFile);

  // After --remove the dir is gone, so nothing pre-existed; pass an
  // empty map so writeScaffoldedFile creates everything fresh.
  const preExistingByPath = removeFirst
    ? new Map<string, PreExistingFile>()
    : new Map<string, PreExistingFile>(preExistingFiles.map((f) => [f.path, f]));

  scaffoldExamples(paths, languages, { keepCustom, preExistingByPath }, createdFiles);

  const gitignoreUpdated = ensureGitignore(cwd);

  return {
    ...baseResult,
    created: true,
    state,
    languages,
    createdFiles,
    gitignoreUpdated,
    preExistingFiles: state === 'pristine' ? [] : preExistingFiles,
  };
}
