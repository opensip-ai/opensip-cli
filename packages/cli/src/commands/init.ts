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
 * Promotion path: when a customer's pack outgrows a handful of .mjs
 * files (shared helpers, tests, more than a dozen checks/scenarios),
 * `opensip-tools/<domain>/` can graduate to a real workspace npm
 * package — `package.json` with `opensipTools.kind: "fit-pack"` or
 * `"sim-pack"`, `tsconfig.json`, `index.ts` re-exporting checks/recipes.
 * Marker-based discovery picks up the workspace package automatically
 * regardless of npm scope. The init scaffold stays loose-`.mjs` to
 * preserve the fast first-touch experience; graduation is a manual
 * step the customer takes when their coverage becomes substantial.
 * See docs/architecture/70-surfaces/02-plugin-authoring.md.
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
 *
 * Partial-state handling:
 *
 * After language resolution, init classifies the working directory
 * into one of four states based on the presence of the config file
 * and the `opensip-tools/` directory:
 *
 *   - 'pristine'             — neither present; scaffold everything.
 *   - 'fully-initialized'    — both present; refuse without a flag.
 *   - 'partial-config-only'  — config XOR dir; refuse without a flag.
 *   - 'partial-dir-only'     — config XOR dir; refuse without a flag.
 *
 * Two flags express explicit user intent for the non-pristine states:
 *
 *   - `--keep`   — re-scaffold examples; preserve custom files.
 *   - `--remove` — delete `opensip-tools/` entirely; scaffold fresh.
 *
 * The two flags are mutually exclusive. The legacy `--force` flag is
 * gone; users who scripted it should migrate to `--remove`, the
 * closest semantic match.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename as pathBasename, join, relative } from 'node:path';

import { CLI_SUPPORTED_SCHEMA_VERSION, resolveProjectPaths, type ProjectContext, type ProjectPaths } from '@opensip-tools/core';

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; init still consumes CliArgs through initOptsToCliArgs in `register()` until the per-command type rip-out
import type { CliArgs, InitResult, PreExistingFile } from '@opensip-tools/contracts';

/**
 * Build the "✗ This directory is already inside an opensip-tools project"
 * refusal message. Same string is embedded in the InitResult.insideExistingProject
 * for --json consumers and rendered by InitFeedback for human-readable output.
 */
function formatInsideExistingProjectMessage(discoveredRoot: string): string {
  return [
    `✗ This directory is already inside an opensip-tools project:`,
    `    ${discoveredRoot}`,
    `    (config: opensip-tools.config.yml)`,
    ``,
    `  What did you want to do?`,
    ``,
    `    • Re-scaffold examples, keep your custom files:`,
    `        opensip-tools init --keep --cwd ${discoveredRoot}`,
    ``,
    `    • Reset the existing project (delete everything, start over):`,
    `        opensip-tools init --remove --cwd ${discoveredRoot}`,
    ``,
    `    • Create a NEW separate project here (rare — only for`,
    `      truly independent sub-projects in a monorepo):`,
    `        opensip-tools init --cwd .`,
  ].join('\n');
}

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
    `schemaVersion: ${CLI_SUPPORTED_SCHEMA_VERSION}`,
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
// than generated per-init) so the same project re-running `init --keep`
// or `init --remove` keeps the same id, and so two projects on the same
// machine can run the example simultaneously without spurious id
// collisions in shared session storage. Per-language ids let the
// polyglot scaffold register distinct checks. UUID v4 random bytes —
// produced once and pinned.
//
// These ids also drive stale-scaffolded detection: a file carrying
// EXAMPLE_CHECK_IDS[<lang>] for a language NOT in the current detection
// set is classified as 'stale-scaffolded' and surfaced (preserved) by
// `--keep`.
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

// =============================================================================
// WORKING-DIRECTORY CLASSIFICATION
// =============================================================================

type WorkingDirState = NonNullable<InitResult['state']>;

/**
 * Classify the working directory into one of four states based on the
 * presence of the config file and the `opensip-tools/` directory.
 *
 * The dir-presence check ignores `opensip-tools/.runtime/` — that
 * subtree is tool-managed (logs, sessions, caches, plugin installs)
 * and the CLI's `preAction` hook creates `.runtime/logs/` before any
 * subcommand runs. Treating a runtime-only dir as a "partial-dir"
 * would misclassify a pristine project the moment the bootstrap hook
 * touches the disk. User-authored content lives under
 * `opensip-tools/{fit,sim}/`; only those count as "the dir is present".
 */
function classifyWorkingDir(paths: ProjectPaths): WorkingDirState {
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

// =============================================================================
// FILE CLASSIFICATION
// =============================================================================

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
    templates.set(join(paths.fitChecksDir, 'example-check.mjs'), exampleCheckSource(lang));
  } else {
    for (const lang of languages) {
      templates.set(join(paths.fitChecksDir, `example-check-${lang}.mjs`), exampleCheckSource(lang, lang));
    }
  }
  const slugs = languages.length === 1
    ? ['example-check']
    : languages.map((lang) => `example-check-${lang}`);
  templates.set(join(paths.fitRecipesDir, 'example-recipe.mjs'), exampleRecipeSource(slugs));
  templates.set(join(paths.simScenariosDir, 'example-scenario.mjs'), exampleScenarioSource());
  templates.set(join(paths.simRecipesDir, 'example-recipe.mjs'), exampleSimRecipeSource());
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
function classifyFiles(
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

// =============================================================================
// PARTIAL-STATE MESSAGE
// =============================================================================

function relativize(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  return rel === '' ? absPath : rel;
}

function buildPartialStateMessage(
  state: WorkingDirState,
  preExistingFiles: readonly PreExistingFile[],
  cwd: string,
): string {
  const lines: string[] = [];
  switch (state) {
    case 'fully-initialized': {
      lines.push('opensip-tools is already initialized in this directory.');
      break;
    }
    case 'partial-config-only': {
      lines.push('opensip-tools.config.yml exists but opensip-tools/ does not.');
      break;
    }
    case 'partial-dir-only': {
      lines.push('opensip-tools/ exists but opensip-tools.config.yml does not.');
      break;
    }
    case 'pristine': {
      // Should not happen in this code path — pristine never errors.
      return 'Unexpected pristine state.';
    }
  }

  if (preExistingFiles.length > 0) {
    lines.push('', `Found ${String(preExistingFiles.length)} file(s) under opensip-tools/:`);
    for (const f of preExistingFiles) {
      lines.push(`  ${relativize(f.path, cwd)}  (${f.classification})`);
    }
  }

  lines.push(
    '',
    'Choose one:',
    '  opensip-tools init --keep    Re-scaffold examples; preserve custom files.',
    '  opensip-tools init --remove  Delete opensip-tools/ and scaffold fresh.',
  );
  return lines.join('\n');
}

// =============================================================================
// SCAFFOLDING
// =============================================================================

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

interface ScaffoldRunInputs {
  readonly paths: ProjectPaths;
  readonly languages: SupportedLanguage[];
  readonly cwd: string;
  readonly state: WorkingDirState;
  readonly preExistingFiles: readonly PreExistingFile[];
  readonly removeFirst: boolean;
  readonly keepCustom: boolean;
}

function runScaffold(
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

// =============================================================================
// EXECUTE
// =============================================================================

/**
 * Run init for the given args. Returns an InitResult — the caller
 * (CLI render layer) prints it.
 */
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge type
export function executeInit(args: CliArgs & { language?: string; keep?: boolean; remove?: boolean; projectContext?: ProjectContext; cwdExplicit?: boolean }): InitResult {
  const cwd = args.cwd;
  const keep = args.keep === true;
  const remove = args.remove === true;
  const paths = resolveProjectPaths(cwd);
  const baseResult = {
    type: 'init' as const,
    path: paths.configFile,
    cwd,
    configFilename: 'opensip-tools.config.yml',
  };

  // Discovery-aware refusal: if cwd sits inside an existing project and
  // the user did NOT pass --cwd explicitly, offer the three corrective
  // actions instead of silently scaffolding a phantom nested project.
  const project = args.projectContext;
  const cwdExplicit = args.cwdExplicit === true;
  if (project?.scope === 'project' && project.projectRoot !== cwd && !cwdExplicit) {
    const message = formatInsideExistingProjectMessage(project.projectRoot);
    return {
      ...baseResult,
      path: '', // no scaffold target — we refused
      created: false,
      insideExistingProject: {
        discoveredRoot: project.projectRoot,
        message,
      },
    };
  }

  // Mutex: --keep and --remove are mutually exclusive.
  if (keep && remove) {
    return {
      ...baseResult,
      created: false,
      partialStateError: {
        state: 'fully-initialized',
        preExistingFiles: [],
        message: '--keep and --remove are mutually exclusive. Pick one.',
      },
    };
  }

  if (!existsSync(cwd)) {
    // A non-existent target directory is a user error, not a "pristine
    // success". Surface it through `ambiguousLanguageError` (which the
    // register-init layer already maps to CONFIGURATION_ERROR / exit 2)
    // so `opensip-tools init --cwd /nonexistent` returns a nonzero exit
    // code with a clear message instead of silently exiting 0.
    return {
      ...baseResult,
      created: false,
      ambiguousLanguageError: {
        detected: [],
        message: `Target directory does not exist: ${cwd}`,
      },
    };
  }

  const resolution = resolveLanguages(cwd, args.language);
  if (!resolution.ok) {
    return { ...baseResult, created: false, ambiguousLanguageError: resolution.error };
  }
  const { languages } = resolution;

  const state = classifyWorkingDir(paths);
  const preExistingFiles = state === 'pristine' ? [] : classifyFiles(paths, languages);

  // Pristine: scaffold and exit. No flag interaction needed.
  if (state === 'pristine') {
    return runScaffold(
      {
        paths,
        languages,
        cwd,
        state,
        preExistingFiles: [],
        removeFirst: false,
        keepCustom: false,
      },
      baseResult,
    );
  }

  // Non-pristine without an explicit flag: refuse with partial-state
  // error.
  if (!keep && !remove) {
    return {
      ...baseResult,
      created: false,
      state,
      languages,
      preExistingFiles,
      partialStateError: {
        state,
        preExistingFiles,
        message: buildPartialStateMessage(state, preExistingFiles, cwd),
      },
    };
  }

  // --remove: blow away the dir, then scaffold from zero.
  if (remove) {
    return runScaffold(
      {
        paths,
        languages,
        cwd,
        state,
        preExistingFiles,
        removeFirst: true,
        keepCustom: false,
      },
      baseResult,
    );
  }

  // --keep: re-scaffold examples; preserve custom + stale-scaffolded files.
  return runScaffold(
    {
      paths,
      languages,
      cwd,
      state,
      preExistingFiles,
      removeFirst: false,
      keepCustom: true,
    },
    baseResult,
  );
}
