/**
 * Pre-existing file classification for `opensip init`.
 *
 * Walks `opensip-cli/` (skipping `.runtime/`) and tags each file as
 * 'scaffolded', 'stale-scaffolded', or 'custom' so `--keep` / `--remove`
 * can decide what to overwrite and what to preserve.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename as pathBasename, join } from 'node:path';

import { INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES } from './init-authored-plan-types.js';
import { ALL_LANGUAGES } from './language-detection.js';

import type { InitAuthoredSnapshotRecord } from './init-authored-plan-types.js';
import type { SupportedLanguage } from './language-detection.js';
import type { RenderedToolScaffold, ToolScaffold } from '../shared.js';
import type { PreExistingFile } from '@opensip-cli/contracts';
import type { ProjectPaths } from '@opensip-cli/core';

const GENERATED_DIR_NAMES = new Set<string>(INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES);

/**
 * Build the full set of scaffold templates that init would write for the given
 * language set — registry-driven (ADR-0038): each tool's `scaffoldExamples` over
 * the current languages, mapped to `userPluginDir(domain, file.kind)/filename`.
 * Same bytes as before; the classifier detects "scaffolded" files via SHA-256.
 */
function buildScaffoldTemplates(
  paths: ProjectPaths,
  toolScaffolds: readonly RenderedToolScaffold[],
): Map<string, string> {
  const templates = new Map<string, string>();
  for (const toolScaffold of toolScaffolds) {
    for (const file of toolScaffold.examples) {
      templates.set(
        join(paths.userPluginDir(toolScaffold.layout.domain, file.kind), file.filename),
        file.content,
      );
    }
  }
  return templates;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface FileClassificationContext {
  readonly templateHashes: ReadonlyMap<string, string>;
  readonly currentLangSet: ReadonlySet<string>;
  readonly staleIds: readonly string[];
}

function buildFileClassificationContext(
  paths: ProjectPaths,
  currentLanguages: readonly SupportedLanguage[],
  toolScaffolds: readonly RenderedToolScaffold[],
): FileClassificationContext {
  const templates = buildScaffoldTemplates(paths, toolScaffolds);
  const templateHashes = new Map<string, string>();
  for (const [absPath, body] of templates) {
    templateHashes.set(absPath, sha256(body));
  }

  // Stale-id detection (ADR-0038): the COMPLETE id universe each tool owns
  // (`stableExampleIds`), minus the ids the CURRENT languages scaffold. A file
  // carrying a complete-but-not-current id is a stale scaffold for a config the
  // project no longer uses; current-config ids are excluded so an edited
  // current-language example (no content-hash match) stays `custom`.
  const completeIds = new Set<string>(
    toolScaffolds.flatMap((toolScaffold) => toolScaffold.stableExampleIds),
  );
  const currentIds = new Set<string>(
    toolScaffolds.flatMap((toolScaffold) => toolScaffold.examples.map((file) => file.stableId)),
  );

  return {
    templateHashes,
    currentLangSet: new Set<string>(currentLanguages),
    staleIds: [...completeIds].filter((id) => !currentIds.has(id)),
  };
}

/**
 * Walk every authored file under `opensip-cli/` (excluding runtime, dependency,
 * and generated-output directories) and tag each one.
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
 * The walk is bounded to the `opensip-cli/` subtree and deliberately avoids
 * following symlinks. The `.runtime/` subdir is skipped so caches/logs/sessions
 * don't pollute the file list; generated directories such as node_modules,
 * dist, coverage, and .turbo are skipped for the same reason.
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

  const rendered = toolScaffolds.map((toolScaffold) => {
    const examples = toolScaffold.scaffoldExamples?.({ languages: currentLanguages }) ?? [];
    return {
      identity: toolScaffold.identity,
      layout: toolScaffold.layout,
      examples,
      stableExampleIds: toolScaffold.stableExampleIds?.() ?? [],
    } satisfies RenderedToolScaffold;
  });
  return classifyFilesFromRenderedScaffolds(paths, currentLanguages, rendered);
}

/**
 * Classify authored files from a callback-free scaffold snapshot. The durable
 * Init planner can evaluate Tool hooks once and reuse the exact rendered files
 * for config generation, planning, and stale-file classification.
 */
export function classifyFilesFromRenderedScaffolds(
  paths: ProjectPaths,
  currentLanguages: readonly SupportedLanguage[],
  toolScaffolds: readonly RenderedToolScaffold[],
): PreExistingFile[] {
  if (!existsSync(paths.userSourceDir)) return [];

  const context = buildFileClassificationContext(paths, currentLanguages, toolScaffolds);

  const out: PreExistingFile[] = [];

  // Walk the dir, skipping runtime/dependency/generated subtrees.
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        // @swallow-ok absence probe while classifying a scaffold tree — an entry that vanished between readdir and lstat is simply not classified, and no decision depends on why
        continue;
      }
      if (
        (st.isDirectory() || st.isSymbolicLink()) &&
        (full === paths.runtimeDir || GENERATED_DIR_NAMES.has(name))
      ) {
        continue;
      }
      if (st.isSymbolicLink()) {
        out.push({ path: full, classification: 'custom' });
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      out.push(classifyOneFile(full, context));
    }
  };
  visit(paths.userSourceDir);

  // Stable order — relative path ascending — so callers can render a
  // deterministic list and tests can assert without sort gymnastics.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function hasGeneratedDirectoryAncestor(
  relativePath: string,
  records: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
): boolean {
  const segments = relativePath.split('/');
  const ancestorSegments = [segments[0] ?? ''];
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    ancestorSegments.push(segment);
    const ancestor = ancestorSegments.join('/');
    const record = records.get(ancestor);
    if (
      GENERATED_DIR_NAMES.has(segment) &&
      record?.exists === true &&
      record.type === 'directory'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Classify the exact authored bytes captured by the durable Init snapshot.
 *
 * This is the planner-facing counterpart to the filesystem walker above. It
 * deliberately performs no filesystem I/O: presentation must describe the
 * same bounded preimage used to construct the replay plan, even if a customer
 * path changes after snapshot capture. Generated-output subtrees retain the
 * same exclusions as the legacy walker.
 */
export function classifySnapshotFilesFromRenderedScaffolds(
  paths: ProjectPaths,
  currentLanguages: readonly SupportedLanguage[],
  toolScaffolds: readonly RenderedToolScaffold[],
  records: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
): PreExistingFile[] {
  const context = buildFileClassificationContext(paths, currentLanguages, toolScaffolds);
  const out: PreExistingFile[] = [];

  for (const [relativePath, record] of records) {
    if (
      !relativePath.startsWith('opensip-cli/') ||
      relativePath === 'opensip-cli/.runtime' ||
      relativePath.startsWith('opensip-cli/.runtime/') ||
      !record.exists ||
      record.type !== 'file' ||
      hasGeneratedDirectoryAncestor(relativePath, records)
    ) {
      continue;
    }
    const absolutePath = join(paths.projectDir, ...relativePath.split('/'));
    const content = Buffer.from(record.contentBase64, 'base64').toString('utf8');
    out.push(classifyFileContent(absolutePath, content, context));
  }

  out.sort((left, right) => left.path.localeCompare(right.path));
  return out;
}

const STALE_FILENAME_PATTERN = /^example-check-([a-z+]+)\.mjs$/;

function classifyOneFile(absPath: string, context: FileClassificationContext): PreExistingFile {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    // Unreadable: surface as custom so we err on the side of preservation.
    return { path: absPath, classification: 'custom' };
  }
  return classifyFileContent(absPath, content, context);
}

function classifyFileContent(
  absPath: string,
  content: string,
  context: FileClassificationContext,
): PreExistingFile {
  // 1) Content-hash match against current-template set.
  const hash = sha256(content);
  if (context.templateHashes.get(absPath) === hash) {
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
      !context.currentLangSet.has(fileLang) &&
      (ALL_LANGUAGES as readonly string[]).includes(fileLang)
    ) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  // 3) Stale-by-pinned-id: any of the aggregated stale ids (the complete tool id
  //    universe minus the current-config ids) embedded in the file.
  for (const id of context.staleIds) {
    if (content.includes(id)) {
      return { path: absPath, classification: 'stale-scaffolded' };
    }
  }

  return { path: absPath, classification: 'custom' };
}
