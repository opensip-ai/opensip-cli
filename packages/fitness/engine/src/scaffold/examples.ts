/**
 * @fileoverview fitness's `init` example contribution (ADR-0038).
 *
 * fitness OWNS the example check/recipe bytes + the pinned check ids that `init`
 * scaffolds — relocated here from the CLI's `config-templates.ts` so a tool's
 * scaffold content lives with the tool (the host just writes the bytes under
 * `userPluginDir('fit', kind)`). The byte content is verbatim; a Phase-0 golden +
 * a Phase-1 parity test pin byte-identity with the legacy CLI builders.
 */

import type { ScaffoldContext, ScaffoldFile } from '@opensip-cli/core';

/**
 * Pinned example-check ids per language — the COMPLETE id universe (drives
 * stale-scaffolded detection regardless of the project's detected languages).
 * Verbatim from the legacy `config-templates.ts`.
 */
export const EXAMPLE_CHECK_IDS: Record<string, string> = {
  typescript: 'a3e1f8c4-9b2d-4f5a-8e6c-7d1a2b3c4d5e',
  rust: 'b4f2e9d5-8c3e-4a6b-9f7d-8e2b3c4d5e6f',
  python: 'c5a3f0e6-7d4f-4b7c-a08e-9f3c4d5e6f70',
  go: 'd6b4a1f7-6e5a-4c8d-b19f-a04d5e6f7081',
  java: 'e7c5b2a8-5f6b-4d9e-c2af-b15e6f708192',
  cpp: 'f8d6c3b9-4a7c-4ea0-d3b0-c26f708192a3',
};

/** Example fitness check source (verbatim). `language` is tool-local `string`. */
export function exampleCheckSource(language: string, polyglotSuffix = ''): string {
  // The example check flags any file containing the literal
  // `EXAMPLE_TODO`. Default behavior on a fresh repo is to pass with
  // 0 violations — it scans real files but finds nothing.
  const slug = polyglotSuffix ? `example-check-${polyglotSuffix}` : 'example-check';
  return `// Example fitness check.
//
// Edit this file or add new .mjs files to opensip-cli/fit/checks/.
// Files in this directory are auto-loaded on the next \`opensip fit\` run.
//
// This demo flags any file containing the literal \`EXAMPLE_TODO\`. After
// you confirm the wiring works, delete or replace it with a real check.
//
// Docs: https://github.com/opensip-ai/opensip-cli#authoring-a-check-package
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHECK_ID = '${EXAMPLE_CHECK_IDS[language] ?? ''}';
const CHECK_SLUG = '${slug}';
const CHECK_DESCRIPTION = 'Demo check — flags any file containing the literal EXAMPLE_TODO';
const CHECK_SCOPE = { languages: ['${language}'], concerns: ['backend'] };
const CHECK_TAGS = ['example'];
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.turbo',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'opensip-cli',
]);
const SOURCE_EXTENSIONS = [
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.rs',
  '.ts',
  '.tsx',
];

function normalizePath(filePath) {
  return filePath.replaceAll(String.fromCharCode(92), '/');
}

function hasSourceExtension(filePath) {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function projectPluginRoot(cwd) {
  return normalizePath(cwd).replace(/\\/+$/, '') + '/opensip-cli/';
}

function isCandidateFile(filePath, cwd) {
  const normalized = normalizePath(filePath);
  return !normalized.startsWith(projectPluginRoot(cwd)) && hasSourceExtension(normalized);
}

async function walkFiles(dir, cwd = dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkFiles(fullPath, cwd)));
    } else if (entry.isFile() && isCandidateFile(fullPath, cwd)) {
      files.push(fullPath);
    }
  }
  return files;
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function warningSignal(filePath, line) {
  return {
    id: 'sig_' + hashString(CHECK_ID + filePath + String(line)),
    source: 'fitness',
    provider: 'opensip-cli',
    severity: 'medium',
    category: 'quality',
    ruleId: 'fit:' + CHECK_SLUG,
    message: 'Found the example trigger string.',
    suggestion:
      'This is just a demo. Delete this scaffolded example check once you have your own checks.',
    filePath,
    line,
    code: { file: filePath, line },
    metadata: { checkSlug: CHECK_SLUG, checkTags: CHECK_TAGS.join(',') },
    createdAt: new Date().toISOString(),
  };
}

async function analyzeFiles(files, read, signal) {
  const findings = [];
  for (const filePath of files) {
    if (signal?.aborted) throw new Error('Check aborted');
    const content = await read(filePath).catch(() => '');
    const index = content.indexOf('EXAMPLE_TODO');
    if (index < 0) continue;
    findings.push(warningSignal(filePath, content.slice(0, index).split('\\n').length));
  }
  return findings;
}

function result(signals, totalItems, durationMs) {
  const errors = signals.filter((s) => s.severity === 'critical' || s.severity === 'high').length;
  const warnings = signals.filter((s) => s.severity === 'medium').length;
  return {
    passed: errors === 0,
    errors,
    warnings,
    signals,
    info: {
      label: signals.length === 0 ? 'No EXAMPLE_TODO markers' : String(signals.length) + ' EXAMPLE_TODO marker(s)',
    },
    metadata: {
      totalItems,
      signals,
      durationMs,
      filesScanned: totalItems,
      itemType: 'files',
    },
  };
}

function emptyMatcher(cwd) {
  return {
    cwd,
    includePatterns: [],
    excludePatterns: [],
    files: async () => [],
    match: async () => ({ files: [], excluded: [], durationMs: 0 }),
    matches: () => false,
    withExcludes: () => emptyMatcher(cwd),
    typescriptOnly: () => emptyMatcher(cwd),
    noTests: () => emptyMatcher(cwd),
  };
}

const exampleCheck = {
  config: {
    id: CHECK_ID,
    slug: CHECK_SLUG,
    tags: CHECK_TAGS,
    description: CHECK_DESCRIPTION,
    analysisMode: 'analyze',
    scope: { include: [], exclude: [], description: 'target-based scope' },
    itemType: 'files',
    scansFiles: true,
    checkScope: CHECK_SCOPE,
    execute: async (ctx) => {
      const start = Date.now();
      const files = (await ctx.matchFiles()).filter((filePath) => isCandidateFile(filePath, ctx.cwd));
      const signals = await analyzeFiles(files, (filePath) => ctx.readFile(filePath), ctx.signal);
      return result(signals, files.length, Date.now() - start);
    },
  },
  getScope: () => ({ include: [], exclude: [], description: 'target-based scope' }),
  getMatcher: (cwd) => emptyMatcher(cwd),
  run: async (cwd, options = {}) => {
    const start = Date.now();
    const files = (options.targetFiles ? [...options.targetFiles] : await walkFiles(cwd)).filter(
      (filePath) => isCandidateFile(filePath, cwd),
    );
    const signals = await analyzeFiles(files, (filePath) => readFile(filePath, 'utf8'), options.signal);
    return result(signals, files.length, Date.now() - start);
  },
};

export const checks = [exampleCheck];
`;
}

/** Example fitness recipe source (verbatim). */
export function exampleRecipeSource(slugs: readonly string[]): string {
  const slugList = slugs.map((s) => `'${s}'`).join(', ');
  return `// Example fitness recipe — runs only the example check(s).
//
// Edit this file or add new .mjs files to opensip-cli/fit/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip fit --recipe example
//
// To run all enabled checks (built-in + your custom ones), omit
// --recipe and the built-in \`default\` recipe applies.
export const recipes = [{
  id: 'URCP_example',
  name: 'example',
  displayName: 'Example',
  description: 'Demo recipe — runs only the example check(s)',
  checks: { type: 'explicit', checkIds: [${slugList}] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
`;
}

/**
 * fitness's scaffold contribution — reproduces `scaffold-writer.ts`'s fit logic:
 * single language ⇒ one `example-check.mjs` + a recipe over `['example-check']`;
 * polyglot ⇒ one `example-check-<lang>.mjs` per language + a recipe over the
 * per-language slugs.
 */
export function fitScaffoldExamples(ctx: ScaffoldContext): ScaffoldFile[] {
  const languages = ctx.languages.length > 0 ? ctx.languages : ['typescript'];
  const single = languages.length === 1;

  // Single language ⇒ one un-suffixed `example-check.mjs`. Polyglot ⇒ one
  // `example-check-<lang>.mjs` per language. A declarative `.map` (not a
  // push-in-loop) keeps the check files' contents the single source.
  const checkFiles: ScaffoldFile[] = single
    ? [
        {
          kind: 'checks',
          filename: 'example-check.mjs',
          content: exampleCheckSource(languages[0] ?? 'typescript'),
          stableId: EXAMPLE_CHECK_IDS[languages[0] ?? 'typescript'] ?? '',
        },
      ]
    : languages.map((lang) => ({
        kind: 'checks',
        filename: `example-check-${lang}.mjs`,
        content: exampleCheckSource(lang, lang),
        stableId: EXAMPLE_CHECK_IDS[lang] ?? '',
      }));

  const slugs = single ? ['example-check'] : languages.map((lang) => `example-check-${lang}`);

  return [
    ...checkFiles,
    {
      kind: 'recipes',
      filename: 'example-recipe.mjs',
      content: exampleRecipeSource(slugs),
      stableId: 'URCP_example',
    },
  ];
}

/** fitness's COMPLETE stable example-id universe (every language's check id). */
export function fitStableExampleIds(): string[] {
  return Object.values(EXAMPLE_CHECK_IDS);
}
