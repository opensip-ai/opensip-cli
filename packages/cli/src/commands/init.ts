/**
 * init command — scaffold the project layout.
 *
 * Creates:
 *   <cwd>/opensip-tools.config.yml                                    (TRACKED)
 *   <cwd>/opensip-tools/fit/checks/example-check.mjs                  (TRACKED)
 *   <cwd>/opensip-tools/fit/recipes/example-recipe.mjs                (TRACKED)
 *   <cwd>/opensip-tools/sim/scenarios/example-scenario.mjs            (TRACKED)
 *   <cwd>/opensip-tools/sim/recipes/example-recipe.mjs                (TRACKED)
 *
 * Appends `opensip-tools/.runtime/` to <cwd>/.gitignore so the
 * tool-generated state (sessions, logs, dashboards, baselines, plugin
 * installs) stays untracked.
 *
 * Language selection drives:
 *   - which `targets:` entry shape goes into the YAML config
 *   - the `scope.languages` field on the example check
 *
 * `--language <list>` (comma-separated) overrides detection.
 * Detection inspects filesystem markers (Cargo.toml, pyproject.toml,
 * go.mod, pom.xml/build.gradle, CMakeLists.txt, package.json+tsconfig).
 * When detection is ambiguous AND --language is missing, init exits
 * 2 with a helpful prompt — no partial scaffolding.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-tools/core';

import type { CliArgs, InitResult } from '@opensip-tools/contracts';

// =============================================================================
// LANGUAGE DETECTION
// =============================================================================

export type SupportedLanguage = 'typescript' | 'rust' | 'python' | 'go' | 'java' | 'cpp';

const ALL_LANGUAGES: readonly SupportedLanguage[] = ['typescript', 'rust', 'python', 'go', 'java', 'cpp'];
const ALL_LANGUAGES_SET = new Set<string>(ALL_LANGUAGES);

interface DetectionMarker {
  readonly language: SupportedLanguage;
  readonly file: string;
  readonly description: string;
}

const MARKERS: readonly DetectionMarker[] = [
  { language: 'rust', file: 'Cargo.toml', description: 'Rust workspace' },
  { language: 'python', file: 'pyproject.toml', description: 'Python project' },
  { language: 'python', file: 'setup.py', description: 'Python project (setup.py)' },
  { language: 'go', file: 'go.mod', description: 'Go module' },
  { language: 'java', file: 'pom.xml', description: 'Maven project' },
  { language: 'java', file: 'build.gradle', description: 'Gradle project' },
  { language: 'cpp', file: 'CMakeLists.txt', description: 'CMake project' },
];

/**
 * Inspect the cwd for language markers. Returns the unique set of
 * detected languages. TypeScript is detected only when there's a
 * `tsconfig.json` (or a `package.json` with no other marker
 * present — fallback for plain JS/TS projects).
 */
export function detectLanguages(cwd: string): SupportedLanguage[] {
  const detected = new Set<SupportedLanguage>();

  for (const marker of MARKERS) {
    if (existsSync(join(cwd, marker.file))) detected.add(marker.language);
  }

  // TypeScript: tsconfig.json is the strong signal. package.json alone
  // is ambiguous — a Rust project might have a docs site with one — but
  // ONLY when no other marker is present, treat it as a TS project.
  const hasTsconfig = existsSync(join(cwd, 'tsconfig.json'));
  const hasPackageJson = existsSync(join(cwd, 'package.json'));
  if (hasTsconfig || (hasPackageJson && detected.size === 0)) {
    detected.add('typescript');
  }

  return [...detected];
}

// =============================================================================
// PER-LANGUAGE CONFIG TEMPLATES
// =============================================================================

interface TargetTemplate {
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

function targetTemplate(lang: SupportedLanguage): TargetTemplate {
  switch (lang) {
    case 'typescript': {
      return {
        name: 'typescript-source',
        description: 'TypeScript / TSX source code',
        languages: ['typescript'],
        include: ['src/**/*.ts', 'src/**/*.tsx', 'packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
        exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/node_modules/**', '**/dist/**'],
      };
    }
    case 'rust': {
      return {
        name: 'rust-source',
        description: 'Rust source code',
        languages: ['rust'],
        include: ['src/**/*.rs', 'crates/**/*.rs', 'services/**/*.rs'],
        exclude: ['**/target/**'],
      };
    }
    case 'python': {
      return {
        name: 'python-source',
        description: 'Python source code',
        languages: ['python'],
        include: ['src/**/*.py', '**/*.py'],
        exclude: ['**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/dist/**', '**/build/**', '**/*.egg-info/**'],
      };
    }
    case 'go': {
      return {
        name: 'go-source',
        description: 'Go source code',
        languages: ['go'],
        include: ['**/*.go'],
        exclude: ['**/vendor/**', '**/_test.go'],
      };
    }
    case 'java': {
      return {
        name: 'java-source',
        description: 'Java source code',
        languages: ['java'],
        include: ['src/main/java/**/*.java', 'src/**/*.java'],
        exclude: ['**/target/**', '**/build/**', '**/*Test.java'],
      };
    }
    case 'cpp': {
      return {
        name: 'cpp-source',
        description: 'C/C++ source code',
        languages: ['cpp'],
        include: ['src/**/*.{c,cpp,cc,h,hpp}', '**/*.{c,cpp,cc,h,hpp}'],
        exclude: ['**/build/**', '**/cmake-build-*/**'],
      };
    }
  }
}

// =============================================================================
// CONFIG GENERATION
// =============================================================================

function generateConfig(languages: readonly SupportedLanguage[]): string {
  const templates = languages.map(targetTemplate);

  const lines: string[] = [
    '# OpenSIP Tools — project configuration',
    '#',
    '# Defines named target file sets for fitness checks. Each fitness',
    '# check declares a `scope` (languages + concerns); discovery',
    '# matches it against these targets to determine which files the',
    '# check runs against.',
    '#',
    '# Docs: https://github.com/opensip-ai/opensip-tools#configuration',
    '',
    'globalExcludes:',
    '  - "**/node_modules/**"',
    '  - "**/dist/**"',
    '',
    'targets:',
  ];

  for (const t of templates) {
    lines.push(
      `  ${t.name}:`,
      `    description: ${t.description}`,
      `    languages: [${t.languages.join(', ')}]`,
      '    concerns: [backend]',
      '    include:',
      ...t.include.map((p) => `      - "${p}"`),
      '    exclude:',
      ...t.exclude.map((p) => `      - "${p}"`),
      '',
    );
  }

  lines.push(
    '# =============================================================================',
    '# Fitness configuration',
    '# =============================================================================',
    '',
    'fitness:',
    '  failOnErrors: 1     # fail if total errors >= this (0 = never fail on errors)',
    '  failOnWarnings: 0   # fail if total warnings >= this (0 = warnings are informational)',
    '  disabledChecks: []',
    '',
  );

  return lines.join('\n');
}

// =============================================================================
// EXAMPLE FILE TEMPLATES
// =============================================================================

// Stable UUIDs for the scaffolded example checks. Hard-coded (rather
// than generated per-init) so the same project re-running `init --force`
// keeps the same id, and so two projects on the same machine can run
// the example simultaneously without spurious id collisions in shared
// session storage. Per-language ids let the polyglot scaffold register
// distinct checks. UUID v4 random bytes — produced once and pinned.
const EXAMPLE_CHECK_IDS: Record<SupportedLanguage, string> = {
  typescript: 'a3e1f8c4-9b2d-4f5a-8e6c-7d1a2b3c4d5e',
  rust:       'b4f2e9d5-8c3e-4a6b-9f7d-8e2b3c4d5e6f',
  python:     'c5a3f0e6-7d4f-4b7c-a08e-9f3c4d5e6f70',
  go:         'd6b4a1f7-6e5a-4c8d-b19f-a04d5e6f7081',
  java:       'e7c5b2a8-5f6b-4d9e-c2af-b15e6f708192',
  cpp:        'f8d6c3b9-4a7c-4ea0-d3b0-c26f708192a3',
};

function exampleCheckSource(language: SupportedLanguage, polyglotSuffix = ''): string {
  // The example check flags any file containing the literal
  // `EXAMPLE_TODO`. Default behavior on a fresh repo is to pass with
  // 0 violations — it scans real files but finds nothing.
  const slug = polyglotSuffix ? `example-check-${polyglotSuffix}` : 'example-check';
  return `// Example fitness check.
//
// Edit this file or add new .mjs files to opensip-tools/fit/checks/.
// Files in this directory are auto-loaded on the next \`opensip-tools fit\` run.
//
// This demo flags any file containing the literal \`EXAMPLE_TODO\`. After
// you confirm the wiring works, delete or replace it with a real check.
//
// Docs: https://github.com/opensip-ai/opensip-tools#authoring-a-check-package
import { defineCheck } from '@opensip-tools/fitness';

export const checks = [
  defineCheck({
    id: '${EXAMPLE_CHECK_IDS[language]}',
    slug: '${slug}',
    description: 'Demo check — flags any file containing the literal EXAMPLE_TODO',
    scope: { languages: ['${language}'], concerns: ['backend'] },
    tags: ['example'],
    analyze: (content, filePath) => {
      const i = content.indexOf('EXAMPLE_TODO');
      if (i < 0) return [];
      return [{
        line: content.slice(0, i).split('\\n').length,
        message: 'Found the example trigger string.',
        severity: 'warning',
        suggestion:
          'This is just a demo. Delete opensip-tools/fit/checks/example-check.mjs ' +
          'once you have your own checks.',
        filePath,
      }];
    },
  }),
];
`;
}

function exampleRecipeSource(slugs: readonly string[]): string {
  const slugList = slugs.map((s) => `'${s}'`).join(', ');
  return `// Example fitness recipe — runs only the example check(s).
//
// Edit this file or add new .mjs files to opensip-tools/fit/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools fit --recipe example
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

function exampleScenarioSource(): string {
  return `// Example simulation scenario — completes immediately.
//
// Edit this file or add new .mjs files to opensip-tools/sim/scenarios/.
// Files in this directory are auto-loaded on the next \`opensip-tools sim\` run.
//
// Docs: https://github.com/opensip-ai/opensip-tools#simulation
import { defineLoadScenario } from '@opensip-tools/simulation';

export const scenarios = [
  defineLoadScenario({
    id: 'example-scenario',
    name: 'example-scenario',
    description: 'Demo scenario — completes immediately with no work',
    tags: ['example'],
    personas: [],
    duration: 0,
    assertions: [],
  }),
];
`;
}

function exampleSimRecipeSource(): string {
  return `// Example simulation recipe — runs only the example scenario.
//
// Edit this file or add new .mjs files to opensip-tools/sim/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools sim --recipe example
import { defineSimulationRecipe } from '@opensip-tools/simulation';

export const recipes = [
  defineSimulationRecipe({
    id: 'URCP_sim_example',
    name: 'example',
    displayName: 'Example',
    description: 'Demo recipe — runs only the example scenario',
    scenarios: { type: 'explicit', scenarioIds: ['example-scenario'] },
    execution: { mode: 'parallel', timeout: 30_000 },
  }),
];
`;
}

// =============================================================================
// .gitignore APPEND
// =============================================================================

const GITIGNORE_LINE = 'opensip-tools/.runtime/';

function ensureGitignore(cwd: string): boolean {
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
  writeFileSync(path, `${content}${sep}\n# opensip-tools runtime state\n${GITIGNORE_LINE}\n`, 'utf8');
  return true;
}

// =============================================================================
// LANGUAGE FLAG PARSING
// =============================================================================

/**
 * Parse the `--language <comma-separated>` argv string into a list of
 * known languages. Throws on unknown entries — the CLI surfaces it as
 * an exit-2 configuration error.
 */
export function parseLanguageFlag(raw: string): SupportedLanguage[] {
  const out: SupportedLanguage[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    if (!ALL_LANGUAGES_SET.has(trimmed)) {
      throw new Error(
        `Unknown language '${trimmed}'. Expected one of: ${ALL_LANGUAGES.join(', ')}`,
      );
    }
    seen.add(trimmed);
    out.push(trimmed as SupportedLanguage);
  }
  if (out.length === 0) {
    throw new Error('--language received an empty list');
  }
  return out;
}

// =============================================================================
// EXECUTE
// =============================================================================

type LanguageResolution =
  | { ok: true; languages: SupportedLanguage[] }
  | { ok: false; error: { detected: SupportedLanguage[]; message: string } };

function resolveLanguages(cwd: string, languageFlag: string | undefined): LanguageResolution {
  if (languageFlag) {
    try {
      return { ok: true, languages: parseLanguageFlag(languageFlag) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { detected: [], message: msg } };
    }
  }
  const detected = detectLanguages(cwd);
  if (detected.length === 0) {
    return {
      ok: false,
      error: {
        detected: [],
        message:
          'No language markers found. Specify with: ' +
          'opensip-tools init --language <typescript|rust|python|go|java|cpp> ' +
          '(comma-separated for polyglot projects).',
      },
    };
  }
  if (detected.length > 1) {
    return {
      ok: false,
      error: {
        detected,
        message:
          `Detected multiple languages: ${detected.join(', ')}. ` +
          `Pass --language <comma-separated-list> to choose. ` +
          `Example: opensip-tools init --language ${detected.join(',')}`,
      },
    };
  }
  return { ok: true, languages: detected };
}

function writeIfMissing(filePath: string, content: string, force: boolean, createdFiles: string[]): void {
  if (force || !existsSync(filePath)) {
    writeFileSync(filePath, content, 'utf8');
    createdFiles.push(filePath);
  }
}

function scaffoldFitChecks(paths: ReturnType<typeof resolveProjectPaths>, languages: SupportedLanguage[], force: boolean, createdFiles: string[]): void {
  mkdirSync(paths.fitChecksDir, { recursive: true });
  if (languages.length === 1) {
    writeIfMissing(
      join(paths.fitChecksDir, 'example-check.mjs'),
      exampleCheckSource(languages[0] ?? 'typescript'),
      force,
      createdFiles,
    );
    return;
  }
  // Polyglot: one example per language so each is independently editable / deletable.
  for (const lang of languages) {
    writeIfMissing(
      join(paths.fitChecksDir, `example-check-${lang}.mjs`),
      exampleCheckSource(lang, lang),
      force,
      createdFiles,
    );
  }
}

function scaffoldExamples(paths: ReturnType<typeof resolveProjectPaths>, languages: SupportedLanguage[], force: boolean, createdFiles: string[]): void {
  scaffoldFitChecks(paths, languages, force, createdFiles);

  mkdirSync(paths.fitRecipesDir, { recursive: true });
  const slugs = languages.length === 1
    ? ['example-check']
    : languages.map((lang) => `example-check-${lang}`);
  writeIfMissing(
    join(paths.fitRecipesDir, 'example-recipe.mjs'),
    exampleRecipeSource(slugs),
    force,
    createdFiles,
  );

  mkdirSync(paths.simScenariosDir, { recursive: true });
  writeIfMissing(
    join(paths.simScenariosDir, 'example-scenario.mjs'),
    exampleScenarioSource(),
    force,
    createdFiles,
  );

  mkdirSync(paths.simRecipesDir, { recursive: true });
  writeIfMissing(
    join(paths.simRecipesDir, 'example-recipe.mjs'),
    exampleSimRecipeSource(),
    force,
    createdFiles,
  );
}

/**
 * Run init for the given args. Returns an InitResult — the caller
 * (CLI render layer) prints it.
 */
export function executeInit(args: CliArgs & { language?: string; force?: boolean }): InitResult {
  const cwd = args.cwd;
  const force = args.force === true;
  const paths = resolveProjectPaths(cwd);
  const baseResult = {
    type: 'init' as const,
    path: paths.configFile,
    cwd,
    configFilename: 'opensip-tools.config.yml',
  };

  if (!existsSync(cwd)) {
    return { ...baseResult, created: false, alreadyExists: false };
  }

  const resolution = resolveLanguages(cwd, args.language);
  if (!resolution.ok) {
    return { ...baseResult, created: false, alreadyExists: false, ambiguousLanguageError: resolution.error };
  }
  const { languages } = resolution;

  if (existsSync(paths.configFile) && !force) {
    return { ...baseResult, created: false, alreadyExists: true, languages };
  }

  // Write the config + scaffold the example tree.
  const createdFiles: string[] = [];
  writeFileSync(paths.configFile, generateConfig(languages), 'utf8');
  createdFiles.push(paths.configFile);

  scaffoldExamples(paths, languages, force, createdFiles);

  // .gitignore — always best-effort, idempotent
  const gitignoreUpdated = ensureGitignore(cwd);

  return {
    ...baseResult,
    created: true,
    alreadyExists: false,
    languages,
    createdFiles,
    gitignoreUpdated,
  };
}
