/**
 * Pre-existing file classification for `opensip-tools init`.
 *
 * Walks `opensip-tools/` (skipping `.runtime/`) and tags each file as
 * 'scaffolded', 'stale-scaffolded', or 'custom' so `--keep` / `--remove`
 * can decide what to overwrite and what to preserve.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename as pathBasename, join } from 'node:path';

import {
  EXAMPLE_CHECK_IDS,
  exampleCheckSource,
  exampleRecipeSource,
  exampleScenarioSource,
  exampleSimRecipeSource,
} from './config-templates.js';

import type { SupportedLanguage } from './language-detection.js';
import type { PreExistingFile } from '@opensip-tools/contracts';
import type { ProjectPaths } from '@opensip-tools/core';

/**
 * Build the full set of scaffold templates that init would write for
 * the given language set. Maps each absolute path to the byte-for-byte
 * content the current init implementation would produce, so the file
 * classifier can detect "scaffolded" files via SHA-256 content match.
 */
function buildScaffoldTemplates(
  paths: ProjectPaths,
  languages: readonly SupportedLanguage[],
): Map<string, string> {
  const templates = new Map<string, string>();
  if (languages.length === 1) {
    const lang = languages[0] ?? 'typescript';
    templates.set(join(paths.userPluginDir('fit', 'checks'), 'example-check.mjs'), exampleCheckSource(lang));
  } else {
    for (const lang of languages) {
      templates.set(join(paths.userPluginDir('fit', 'checks'), `example-check-${lang}.mjs`), exampleCheckSource(lang, lang));
    }
  }
  const slugs = languages.length === 1
    ? ['example-check']
    : languages.map((lang) => `example-check-${lang}`);
  templates.set(join(paths.userPluginDir('fit', 'recipes'), 'example-recipe.mjs'), exampleRecipeSource(slugs));
  templates.set(join(paths.userPluginDir('sim', 'scenarios'), 'example-scenario.mjs'), exampleScenarioSource());
  templates.set(join(paths.userPluginDir('sim', 'recipes'), 'example-recipe.mjs'), exampleSimRecipeSource());
  return templates;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Walk every file under `opensip-tools/` (excluding `.runtime/`, which
 * is gitignored runtime state and not user-authored) and tag each one.
 *
 * Classification rules:
 *
 *   - 'scaffolded'        — content matches a current-template byte-for-byte.
 *   - 'stale-scaffolded'  — file shape matches a previous-language scaffold:
 *                           filename `example-check-<lang>.mjs` for <lang>
 *                           NOT in the current detection set, OR the file
 *                           carries a pinned EXAMPLE_CHECK_IDS UUID for a
 *                           language not in the current set.
 *   - 'custom'            — anything else (user-authored).
 *
 * The walk is bounded to the `opensip-tools/` subtree (kilobytes in
 * practice). The `.runtime/` subdir is skipped so caches/logs/sessions
 * don't pollute the file list.
 *
 * Note on hash-based scaffolded detection: a scaffolded file that has
 * been line-ending normalized (CRLF↔LF) or stripped of a trailing
 * newline by an editor will not byte-for-byte match the template. In
 * that case it falls back to 'custom' or 'stale-scaffolded' (when the
 * UUID still matches but content drifted). The UUID-based fallback
 * catches the common "stale language" case; cosmetic drift on a
 * current-language file is treated as custom — which is the safer
 * outcome (won't silently overwrite).
 */
export function classifyFiles(
  paths: ProjectPaths,
  currentLanguages: readonly SupportedLanguage[],
): PreExistingFile[] {
  if (!existsSync(paths.userSourceDir)) return [];

  const templates = buildScaffoldTemplates(paths, currentLanguages);
  const templateHashes = new Map<string, string>();
  for (const [absPath, body] of templates) {
    templateHashes.set(absPath, sha256(body));
  }
  const currentLangSet = new Set<string>(currentLanguages);

  const out: PreExistingFile[] = [];

  // Walk the dir, skipping `.runtime/`.
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // @fitness-ignore-next-line error-handling-quality -- directory walk probe: an unreadable directory means "no entries to classify here", same as a genuinely empty dir; failure IS the signal.
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      // Skip runtime state (gitignored, tool-managed).
      if (full === paths.runtimeDir) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      out.push(classifyOneFile(full, templateHashes, currentLangSet));
    }
  };
  visit(paths.userSourceDir);

  // Stable order — relative path ascending — so callers can render a
  // deterministic list and tests can assert without sort gymnastics.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

const STALE_FILENAME_PATTERN = /^example-check-([a-z+]+)\.mjs$/;

function classifyOneFile(
  absPath: string,
  templateHashes: ReadonlyMap<string, string>,
  currentLangSet: ReadonlySet<string>,
): PreExistingFile {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    // Unreadable: surface as custom so we err on the side of preservation.
    return { path: absPath, classification: 'custom' };
  }

  // 1) Content-hash match against current-template set.
  const hash = sha256(content);
  if (templateHashes.get(absPath) === hash) {
    return { path: absPath, classification: 'scaffolded' };
  }

  // 2) Stale-by-filename: example-check-<lang>.mjs for <lang> not in
  //    current set.
  // Use node:path basename so the separator extraction works on Windows.
  // A hard-coded '/' would leave `basename` equal to the whole absolute
  // Windows path (`lastIndexOf('/')` returns -1), and STALE_FILENAME_PATTERN
  // would never match — silently misclassifying every stale-scaffolded
  // file as 'custom' and breaking `--keep` semantics on Windows.
  const basename = pathBasename(absPath);
  const filenameMatch = STALE_FILENAME_PATTERN.exec(basename);
  if (filenameMatch) {
    const fileLang = filenameMatch[1];
    if (fileLang && !currentLangSet.has(fileLang) && fileLang in EXAMPLE_CHECK_IDS) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  // 3) Stale-by-pinned-UUID: any EXAMPLE_CHECK_IDS UUID for a language
  //    not in the current set, embedded in the file.
  for (const [lang, uuid] of Object.entries(EXAMPLE_CHECK_IDS)) {
    if (currentLangSet.has(lang)) continue;
    if (content.includes(uuid)) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  return { path: absPath, classification: 'custom' };
}
