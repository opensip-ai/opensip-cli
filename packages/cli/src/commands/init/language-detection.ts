/**
 * Language detection for `opensip-tools init`.
 *
 * Inspects the cwd for well-known language markers (Cargo.toml,
 * pyproject.toml, go.mod, pom.xml/build.gradle, CMakeLists.txt,
 * tsconfig.json/package.json) and returns the unique set of detected
 * languages. Also parses the `--language <comma-separated>` flag that
 * overrides detection.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type SupportedLanguage = 'typescript' | 'rust' | 'python' | 'go' | 'java' | 'cpp';

const ALL_LANGUAGES: readonly SupportedLanguage[] = [
  'typescript',
  'rust',
  'python',
  'go',
  'java',
  'cpp',
];
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

/**
 * Parse the `--language <comma-separated>` argv string into a list of
 * known languages. Throws on unknown entries — the CLI surfaces it as
 * an exit-2 configuration error.
 *
 * @throws {Error} When `raw` contains a token not present in `ALL_LANGUAGES`.
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

export type LanguageResolution =
  | { ok: true; languages: SupportedLanguage[] }
  | { ok: false; error: { detected: SupportedLanguage[]; message: string } };

/**
 * Resolve the language set for an init run: either parse the explicit
 * --language flag, or fall back to filesystem detection. Returns an
 * error variant when no markers are found, or when multiple languages
 * are detected without --language to disambiguate.
 */
export function resolveLanguages(
  cwd: string,
  languageFlag: string | undefined,
): LanguageResolution {
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
