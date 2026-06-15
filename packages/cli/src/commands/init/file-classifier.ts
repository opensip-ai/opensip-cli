/**
 * Pre-existing file classification for `opensip init`.
 *
 * Walks `opensip-cli/` (skipping `.runtime/`) and tags each file as
 * 'scaffolded', 'stale-scaffolded', or 'custom' so `--keep` / `--remove`
 * can decide what to overwrite and what to preserve.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename as pathBasename, join } from 'node:path';

import { ALL_LANGUAGES } from './language-detection.js';

import type { SupportedLanguage } from './language-detection.js';
import type { ToolScaffold } from '../shared.js';
import type { PreExistingFile } from '@opensip-cli/contracts';
import type { ProjectPaths } from '@opensip-cli/core';

/**
 * Build the full set of scaffold templates that init would write for the given
 * language set — registry-driven (ADR-0038): each tool's `scaffoldExamples` over
 * the current languages, mapped to `userPluginDir(domain, file.kind)/filename`.
 * Same bytes as before; the classifier detects "scaffolded" files via SHA-256.
 */
function buildScaffoldTemplates(
  paths: ProjectPaths,
  languages: readonly SupportedLanguage[],
  toolScaffolds: readonly ToolScaffold[],
): Map<string, string> {
  const templates = new Map<string, string>();
  for (const ts of toolScaffolds) {
    if (!ts.scaffoldExamples) continue;
    for (const file of ts.scaffoldExamples({ languages })) {
      templates.set(
        join(paths.userPluginDir(ts.layout.domain, file.kind), file.filename),
        file.content,
      );
    }
  }
  return templates;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Walk every file under `opensip-cli/` (excluding `.runtime/`, which
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
 * The walk is bounded to the `opensip-cli/` subtree (kilobytes in
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
  toolScaffolds: readonly ToolScaffold[],
): PreExistingFile[] {
  if (!existsSync(paths.userSourceDir)) return [];

  const templates = buildScaffoldTemplates(paths, currentLanguages, toolScaffolds);
  const templateHashes = new Map<string, string>();
  for (const [absPath, body] of templates) {
    templateHashes.set(absPath, sha256(body));
  }
  const currentLangSet = new Set<string>(currentLanguages);

  // Stale-id detection (ADR-0038): the COMPLETE id universe each tool owns
  // (`stableExampleIds`), minus the ids the CURRENT languages scaffold. A file
  // carrying a complete-but-not-current id is a stale scaffold for a config the
  // project no longer uses; current-config ids are excluded so an edited
  // current-language example (no content-hash match) stays `custom`.
  const completeIds = new Set<string>(toolScaffolds.flatMap((ts) => ts.stableExampleIds?.() ?? []));
  const currentIds = new Set<string>(
    toolScaffolds.flatMap((ts) =>
      (ts.scaffoldExamples?.({ languages: currentLanguages }) ?? []).map((f) => f.stableId),
    ),
  );
  const staleIds = [...completeIds].filter((id) => !currentIds.has(id));

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
      out.push(classifyOneFile(full, templateHashes, currentLangSet, staleIds));
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
  staleIds: readonly string[],
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
    if (
      fileLang &&
      !currentLangSet.has(fileLang) &&
      (ALL_LANGUAGES as readonly string[]).includes(fileLang)
    ) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  // 3) Stale-by-pinned-id: any of the aggregated stale ids (the complete tool id
  //    universe minus the current-config ids) embedded in the file.
  for (const id of staleIds) {
    if (content.includes(id)) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  return { path: absPath, classification: 'custom' };
}
