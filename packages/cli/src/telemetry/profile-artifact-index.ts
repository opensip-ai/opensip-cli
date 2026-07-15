import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SERVICE_NAME = 'opensip-cli';
const MAX_LABEL_LENGTH = 128;
const MAX_SLUG_LENGTH = 48;
const UNIQUE_SUFFIX_LENGTH = 12;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const indexedMetadata = new WeakSet<object>();

export interface ProfileArtifactLabels {
  readonly service: typeof SERVICE_NAME;
  readonly runId: string;
  readonly command: string;
}

/** Small, content-free description of one local CPU-profile artifact pair. */
export interface ProfileArtifactMetadata {
  readonly directory: string;
  readonly containmentRoot: string;
  readonly profilePath: string;
  readonly labelsPath: string;
  readonly labels: ProfileArtifactLabels;
  readonly startedAt: string;
  readonly status: 'reserved' | 'complete';
  readonly completedAt?: string;
}

export interface CreateProfileArtifactIndexInput {
  readonly baseDir: string;
  /** Existing trusted ancestor beneath which directory links are rejected. */
  readonly containmentRoot?: string;
  readonly command?: string;
  readonly runId?: string;
  /** Injectable for deterministic tests. */
  readonly startedAt?: Date;
  /** Injectable for deterministic tests. */
  readonly processId?: number;
  /** Injectable for deterministic collision tests. */
  readonly uniqueSuffix?: string;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function truncateWithHash(value: string, maxLength: number): string {
  const characters = [...value];
  if (characters.length <= maxLength) return value;
  const suffix = `~${shortHash(value)}`;
  return `${characters.slice(0, maxLength - suffix.length).join('')}${suffix}`;
}

function boundedLabel(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback)
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateWithHash(normalized.length > 0 ? normalized : fallback, MAX_LABEL_LENGTH);
}

function safeSlug(value: string, fallback: string, maxLength = MAX_SLUG_LENGTH): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
  const candidate = normalized
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  const readable = candidate.length > 0 ? candidate : fallback;
  const changed = readable !== value || readable.length > maxLength;
  if (!changed) return readable;
  const suffix = `-${shortHash(value)}`;
  return `${readable.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
}

/** @throws {RangeError} When `value` is not a positive safe integer. */
function safeProcessId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('processId must be a positive safe integer');
  }
  return String(value);
}

/** @throws {RangeError} When `value` is not a valid Date. */
function safeStartedAt(value: Date): {
  readonly iso: string;
  readonly filename: string;
} {
  if (Number.isNaN(value.getTime())) throw new RangeError('startedAt must be a valid date');
  const iso = value.toISOString();
  return { iso, filename: iso.replace(/[:.]/g, '-') };
}

function sealMetadata(value: ProfileArtifactMetadata): ProfileArtifactMetadata {
  const metadata = Object.freeze({ ...value });
  indexedMetadata.add(metadata);
  return metadata;
}

/** @throws {Error} When metadata is foreign or fails its directory binding. */
function assertArtifactPair(metadata: ProfileArtifactMetadata): {
  readonly baseDir: string;
  readonly containmentRoot: string;
} {
  if (!indexedMetadata.has(metadata)) {
    throw new Error('profile artifact metadata was not created by the artifact index');
  }
  const baseDir = resolve(metadata.directory);
  const containmentRoot = resolve(metadata.containmentRoot);
  const profileDir = dirname(resolve(metadata.profilePath));
  const labelsDir = dirname(resolve(metadata.labelsPath));
  const profileName = basename(metadata.profilePath);
  const labelsName = basename(metadata.labelsPath);
  if (
    metadata.directory !== baseDir ||
    metadata.containmentRoot !== containmentRoot ||
    !isPathWithin(containmentRoot, baseDir) ||
    profileDir !== baseDir ||
    labelsDir !== baseDir ||
    !profileName.endsWith('.cpuprofile') ||
    !labelsName.endsWith('.labels.json') ||
    profileName.slice(0, -'.cpuprofile'.length) !== labelsName.slice(0, -'.labels.json'.length)
  ) {
    throw new Error('profile artifact metadata failed its directory binding');
  }
  return { baseDir, containmentRoot };
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..')
  );
}

/** @throws {Error} When `baseDir` escapes the containment root or a component is not a real directory. */
function ensurePrivateArtifactDirectory(baseDir: string, containmentRoot: string): void {
  if (!isPathWithin(containmentRoot, baseDir)) {
    throw new Error('profile artifact directory escaped its containment root');
  }
  ensureDirectory(containmentRoot, true);
  const pathFromRoot = relative(containmentRoot, baseDir);
  let cursor = containmentRoot;
  for (const component of pathFromRoot.split(sep).filter((entry) => entry.length > 0)) {
    cursor = resolve(cursor, component);
    ensureDirectory(cursor, false);
  }
}

/** @throws {Error} When `path` exists but is a symlink or non-directory. */
function ensureDirectory(path: string, recursive: boolean): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive, mode: PRIVATE_DIRECTORY_MODE });
    stats = lstatSync(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`profile artifact directory component is not a real directory: ${path}`);
  }
}

/**
 * Construct collision-resistant artifact paths beneath exactly one caller-selected
 * directory. Command/run labels never become path components without slugging and
 * bounding first; the original bounded values live only in the JSON sidecar.
 *
 * @throws {Error} When the directory is empty, escapes containment, or path construction fails.
 * @throws {RangeError} When processId/startedAt inputs are invalid.
 */
export function createProfileArtifactIndex(
  input: CreateProfileArtifactIndexInput,
): ProfileArtifactMetadata {
  if (input.baseDir.trim().length === 0) throw new Error('profile artifact directory is empty');
  let baseDir = resolve(input.baseDir.trim());
  let containmentRoot = resolve(input.containmentRoot ?? dirname(baseDir));
  if (!isPathWithin(containmentRoot, baseDir)) {
    throw new Error('profile artifact directory escaped its containment root');
  }
  try {
    if (lstatSync(containmentRoot).isSymbolicLink()) {
      const canonicalRoot = realpathSync(containmentRoot);
      baseDir = resolve(canonicalRoot, relative(containmentRoot, baseDir));
      containmentRoot = canonicalRoot;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing containment root is created privately below. Existing roots are
    // canonicalized so trusted OS aliases such as macOS /tmp do not look like a
    // symlink inside the caller-selected artifact subtree.
  }
  const command = boundedLabel(input.command, 'unknown');
  const runId = boundedLabel(input.runId, 'unknown');
  const timestamp = safeStartedAt(input.startedAt ?? new Date());
  const processId = safeProcessId(input.processId ?? process.pid);
  const uniqueSuffix = safeSlug(
    input.uniqueSuffix ?? randomUUID().replaceAll('-', '').slice(0, UNIQUE_SUFFIX_LENGTH),
    'artifact',
    UNIQUE_SUFFIX_LENGTH,
  );
  const basename = [
    'opensip-profile',
    timestamp.filename,
    safeSlug(command, 'cli'),
    safeSlug(runId, 'unknown'),
    `p${processId}`,
    uniqueSuffix,
  ].join('-');
  const profilePath = resolve(baseDir, `${basename}.cpuprofile`);
  const labelsPath = resolve(baseDir, `${basename}.labels.json`);

  // A final containment assertion makes the security property independent of the
  // slug implementation above. Both candidates must be direct children.
  if (dirname(profilePath) !== baseDir || dirname(labelsPath) !== baseDir) {
    throw new Error('profile artifact path escaped the selected directory');
  }

  const labels = Object.freeze({ service: SERVICE_NAME, runId, command });
  return sealMetadata({
    directory: baseDir,
    containmentRoot,
    profilePath,
    labelsPath,
    labels,
    startedAt: timestamp.iso,
    status: 'reserved',
  });
}

/**
 * @throws {Error} When metadata fails its directory binding.
 * @throws {RangeError} When `completedAt` is not a valid Date.
 */
function completeProfileArtifactIndex(
  metadata: ProfileArtifactMetadata,
  completedAt = new Date(),
): ProfileArtifactMetadata {
  assertArtifactPair(metadata);
  if (Number.isNaN(completedAt.getTime())) throw new RangeError('completedAt must be a valid date');
  return sealMetadata({
    directory: metadata.directory,
    containmentRoot: metadata.containmentRoot,
    profilePath: metadata.profilePath,
    labelsPath: metadata.labelsPath,
    labels: metadata.labels,
    startedAt: metadata.startedAt,
    status: 'complete',
    completedAt: completedAt.toISOString(),
  });
}

/** Reserve the labels sidecar without following/overwriting an existing path. */
export function writeProfileArtifactLabels(metadata: ProfileArtifactMetadata): void {
  const { baseDir, containmentRoot } = assertArtifactPair(metadata);
  ensurePrivateArtifactDirectory(baseDir, containmentRoot);
  writeFileSync(metadata.labelsPath, `${JSON.stringify(metadata.labels, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: PRIVATE_FILE_MODE,
  });
}

/**
 * Atomically publish the CPU profile and only then return complete metadata.
 *
 * @throws {Error} When metadata fails its directory binding or the temp path escapes.
 * @throws {TypeError} When `profile` is not JSON-serializable.
 * @throws {RangeError} When `completedAt` is not a valid Date.
 */
export function writeCpuProfileArtifact(
  metadata: ProfileArtifactMetadata,
  profile: unknown,
  completedAt = new Date(),
): ProfileArtifactMetadata {
  const { baseDir, containmentRoot } = assertArtifactPair(metadata);
  const serialized = JSON.stringify(profile);
  if (serialized === undefined) throw new TypeError('CPU profile was not JSON-serializable');
  // Prepare and validate the completion value before publication. It remains
  // private to this function unless the atomic publish below succeeds.
  const complete = completeProfileArtifactIndex(metadata, completedAt);
  ensurePrivateArtifactDirectory(baseDir, containmentRoot);
  const temporaryPath = resolve(
    baseDir,
    `.${basename(metadata.profilePath)}.${randomUUID().replaceAll('-', '')}.tmp`,
  );
  if (dirname(temporaryPath) !== baseDir) {
    throw new Error('temporary profile artifact escaped the selected directory');
  }
  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    // Publishing by hard link is atomic and fails with EEXIST instead of
    // overwriting a collision or symlink at the final path.
    linkSync(temporaryPath, metadata.profilePath);
    return complete;
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // @swallow-ok a valid final profile must not be reported failed because
      // best-effort cleanup of its private temporary hard link was denied
    }
  }
}

/** Remove only the reserved labels sidecar after start/stop failed. */
export function discardProfileArtifactLabels(metadata: ProfileArtifactMetadata): void {
  assertArtifactPair(metadata);
  rmSync(metadata.labelsPath, { force: true });
}

/** Remove exactly one indexed pair during explicit best-effort cleanup. */
export function discardProfileArtifacts(metadata: ProfileArtifactMetadata): void {
  assertArtifactPair(metadata);
  rmSync(metadata.profilePath, { force: true });
  rmSync(metadata.labelsPath, { force: true });
}
