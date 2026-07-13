import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listGitVisibleFixtureFiles } from '../runner/fixture-inventory.js';
import { HarnessPrerequisiteError } from '../runner/spawn.js';

import type { GoldTask } from '../model/task.js';
import type { FixtureInventoryFile } from '../runner/fixture-inventory.js';

const DEFAULT_FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__',
);
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_FIXTURES_ROOT, '../../..');
const MAX_CONTRACT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTRACT_BYTES = 32 * 1024 * 1024;
const MAX_CONTRACT_FIXTURE_IDENTITIES = 5;
const MAX_MATERIALIZED_FIXTURE_INVENTORIES = 4;

export interface ContractFingerprintOptions {
  readonly fixturesRoot?: string;
  readonly repositoryRoot?: string;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Resolve one real, contained, non-symlink fixture directory.
 *
 * @throws {HarnessPrerequisiteError} When the fixture name or directory is unsafe or unavailable.
 */
function fixtureDirectory(fixturesRoot: string, fixture: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(fixture)) {
    throw new HarnessPrerequisiteError(`Agent-eval fixture name is invalid: ${fixture}`);
  }
  const lexicalRoot = resolve(fixturesRoot);
  const directory = resolve(lexicalRoot, fixture);
  const child = relative(lexicalRoot, directory);
  if (child.length === 0 || child === '..' || child.startsWith(`..${sep}`)) {
    throw new HarnessPrerequisiteError(`Agent-eval fixture path escapes its root: ${fixture}`);
  }
  let root: string;
  let canonicalDirectory: string;
  try {
    if (lstatSync(directory).isSymbolicLink()) {
      throw new HarnessPrerequisiteError('Agent-eval contract fixture roots may not be symlinks.');
    }
    root = realpathSync(lexicalRoot);
    canonicalDirectory = realpathSync(directory);
  } catch (error) {
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError(`Agent-eval contract fixture is unavailable: ${fixture}`);
  }
  const canonicalChild = relative(root, canonicalDirectory);
  if (
    canonicalChild.length === 0 ||
    canonicalChild === '..' ||
    canonicalChild.startsWith(`..${sep}`)
  ) {
    throw new HarnessPrerequisiteError(`Agent-eval fixture path escapes its root: ${fixture}`);
  }
  return canonicalDirectory;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function authoredContract(task: GoldTask): unknown {
  return {
    assertions: task.assertions,
    ...(task.staleness === undefined ? {} : { edit: task.staleness.edit }),
    fixture: task.fixture,
    id: task.id,
    question: task.question,
    tags: task.tags ?? [],
  };
}

function updateHash(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  hash.update(value);
}

/**
 * Feed one fixture's portable identity and bytes into the contract digest.
 *
 * @throws {HarnessPrerequisiteError | Error} When fixture inspection fails or exceeds a bound.
 */
function updateFixture(
  hash: ReturnType<typeof createHash>,
  fixture: string,
  files: readonly FixtureInventoryFile[],
): void {
  updateHash(hash, `fixture\0${fixture}\0`);
  if (fixture === 'dogfood') {
    updateHash(hash, 'source-bound-to-report-git-sha\0');
    return;
  }
  let totalBytes = 0;
  for (const file of files) {
    const content = readFileSync(file.absolutePath);
    if (content.byteLength > MAX_CONTRACT_FILE_BYTES) {
      throw new HarnessPrerequisiteError(
        `Agent-eval contract fixture file exceeds bounds: ${file.relativePath}`,
      );
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_CONTRACT_BYTES) {
      throw new HarnessPrerequisiteError('Agent-eval contract fixture bytes exceed bounds.');
    }
    updateHash(hash, `file\0${file.relativePath}\0${String(content.byteLength)}\0`);
    updateHash(hash, content);
    updateHash(hash, '\0');
  }
}

/**
 * Fingerprint frozen task truth and committed fixture bytes while intentionally
 * excluding versioned arm strategies.
 *
 * @throws {HarnessPrerequisiteError | Error} When a selected fixture cannot be safely hashed.
 */
export async function contractFingerprint(
  tasks: readonly GoldTask[],
  options: ContractFingerprintOptions = {},
): Promise<string> {
  const ordered = [...tasks].sort((left, right) => compareCodePoints(left.id, right.id));
  const fixtures = [...new Set(ordered.map((task) => task.fixture))].sort(compareCodePoints);
  if (fixtures.length > MAX_CONTRACT_FIXTURE_IDENTITIES) {
    throw new HarnessPrerequisiteError(
      'Agent-eval contract fixture identity count exceeds its bound.',
    );
  }
  const materializedFixtures = fixtures.filter((fixture) => fixture !== 'dogfood');
  if (materializedFixtures.length > MAX_MATERIALIZED_FIXTURE_INVENTORIES) {
    throw new HarnessPrerequisiteError(
      'Agent-eval materialized contract fixture count exceeds its bound.',
    );
  }
  const fixturesRoot = options.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const repositoryRoot = options.repositoryRoot ?? options.fixturesRoot ?? DEFAULT_REPOSITORY_ROOT;
  const inventories = new Map<string, readonly FixtureInventoryFile[]>();
  // @sequential-ok -- At most four fixture inventories run serially to bound child processes.
  for (const fixture of materializedFixtures) {
    inventories.set(
      fixture,
      await listGitVisibleFixtureFiles(fixtureDirectory(fixturesRoot, fixture), repositoryRoot),
    );
  }
  const hash = createHash('sha256');
  updateHash(hash, 'opensip-agent-eval-contract-v1\0');
  for (const task of ordered) updateHash(hash, `task\0${stableJson(authoredContract(task))}\0`);
  for (const fixture of fixtures) {
    updateFixture(hash, fixture, inventories.get(fixture) ?? []);
  }
  return `sha256:${hash.digest('hex')}`;
}
