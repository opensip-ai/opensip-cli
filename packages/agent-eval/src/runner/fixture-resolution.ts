import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HarnessPrerequisiteError } from './spawn.js';
import { resolveInsideRoot } from './workspace-paths.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_FIXTURES_ROOT = resolve(PACKAGE_ROOT, '__fixtures__');
const DEFAULT_REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..');

export const DOGFOOD_FIXTURE_REFERENCE = 'dogfood';
export const REUSE_EXISTING_MODE = 'reuse-existing';

const FIXTURE_LANGUAGES = Object.freeze({
  'customer-py': 'python',
  'customer-staleness': 'typescript',
  'customer-ts': 'typescript',
  'customer-workspace': 'typescript',
} as const);

type FixtureName = keyof typeof FIXTURE_LANGUAGES;
type FixtureLanguage = (typeof FIXTURE_LANGUAGES)[FixtureName];

/** A disposable fixture source or the existing dogfood workspace. */
export type FixtureResolution =
  | {
      readonly language: FixtureLanguage;
      readonly mode: 'fixture';
      readonly repositoryRoot: string;
      readonly sourceRoot: string;
    }
  | {
      readonly mode: typeof REUSE_EXISTING_MODE;
      readonly workspaceRoot: string;
    };

/** Optional roots used to resolve fixture and dogfood references. */
export interface FixtureResolutionOptions {
  readonly fixturesRoot?: string;
  readonly repositoryRoot?: string;
}

/**
 * Canonicalize and verify a required directory.
 *
 * @throws {HarnessPrerequisiteError} When the path is missing or is not a directory.
 */
function requireDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new HarnessPrerequisiteError(`${label} is missing: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new HarnessPrerequisiteError(`${label} is not a directory: ${path}`);
  }
  return canonical;
}

function isFixtureName(value: string): value is FixtureName {
  return Object.hasOwn(FIXTURE_LANGUAGES, value);
}

/**
 * Resolve the closed fixture vocabulary at the package's single path boundary.
 *
 * @throws {HarnessPrerequisiteError} When the reference or required directory is invalid.
 */
export function resolveFixtureReference(
  reference: string,
  options: FixtureResolutionOptions = {},
): FixtureResolution {
  if (reference === DOGFOOD_FIXTURE_REFERENCE) {
    return {
      mode: REUSE_EXISTING_MODE,
      workspaceRoot: requireDirectory(
        options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
        'Dogfood repository root',
      ),
    };
  }
  if (!isFixtureName(reference)) {
    throw new HarnessPrerequisiteError(`Unknown agent-eval fixture reference: ${reference}`);
  }
  const fixturesRoot = requireDirectory(
    options.fixturesRoot ?? DEFAULT_FIXTURES_ROOT,
    'Agent-eval fixtures root',
  );
  const sourceRoot = requireDirectory(
    resolveInsideRoot(fixturesRoot, reference),
    `Agent-eval fixture ${reference}`,
  );
  const repositoryRoot = requireDirectory(
    options.repositoryRoot ?? options.fixturesRoot ?? DEFAULT_REPOSITORY_ROOT,
    'Agent-eval fixture repository root',
  );
  return {
    language: FIXTURE_LANGUAGES[reference],
    mode: 'fixture',
    repositoryRoot,
    sourceRoot,
  };
}
