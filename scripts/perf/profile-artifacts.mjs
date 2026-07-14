import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const MAX_PROFILE_ARTIFACTS = 64;
export const MAX_PROFILE_FILENAME_BYTES = 200;
export const MAX_PROFILE_LABEL_BYTES = 64 * 1024;

/** Capture bounded metadata only. Profile bodies and label contents are never read. */
export async function captureProfileArtifactSnapshot(directory, deps = {}) {
  const root = resolve(directory);
  let entries;
  try {
    entries = await (deps.readdir ?? readdir)(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { directory: root, entries: new Map(), omittedCount: 0 };
    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const indexed = new Map();
  let omittedCount = entries.length - candidates.length;
  for (const name of candidates) {
    if (indexed.size >= MAX_PROFILE_ARTIFACTS) {
      omittedCount += 1;
      continue;
    }
    const kind = artifactKind(name);
    if (kind === null || Buffer.byteLength(name, 'utf8') > MAX_PROFILE_FILENAME_BYTES) {
      omittedCount += 1;
      continue;
    }
    const path = join(root, name);
    if (dirname(resolve(path)) !== root) {
      omittedCount += 1;
      continue;
    }
    const stats = await (deps.lstat ?? lstat)(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      omittedCount += 1;
      continue;
    }
    if (kind === 'labels' && stats.size > MAX_PROFILE_LABEL_BYTES) {
      omittedCount += 1;
      continue;
    }
    indexed.set(name, {
      file: name,
      kind,
      sizeBytes: stats.size,
      modifiedMs: Math.round(stats.mtimeMs),
    });
  }
  return { directory: root, entries: indexed, omittedCount };
}

/** Return only new or changed artifacts between two bounded snapshots. */
export function indexNewProfileArtifacts(before, after) {
  if (before.directory !== after.directory) {
    throw new Error('Profile artifact snapshots must use the same directory.');
  }
  const files = [];
  for (const [name, entry] of after.entries) {
    const previous = before.entries.get(name);
    if (
      previous === undefined ||
      previous.sizeBytes !== entry.sizeBytes ||
      previous.modifiedMs !== entry.modifiedMs
    ) {
      files.push({
        file: entry.file,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
      });
    }
  }
  return {
    directory: after.directory,
    files,
    omittedCount: before.omittedCount + after.omittedCount,
  };
}

/** True only when the bounded index contains a same-basename profile/labels pair. */
export function hasProfileArtifactPair(index) {
  if (!Array.isArray(index?.files)) return false;
  const profiles = new Set(
    index.files
      .filter((entry) => entry?.kind === 'cpu-profile' && entry.file.endsWith('.cpuprofile'))
      .map((entry) => entry.file.slice(0, -'.cpuprofile'.length)),
  );
  return index.files.some(
    (entry) =>
      entry?.kind === 'labels' &&
      entry.file.endsWith('.labels.json') &&
      profiles.has(entry.file.slice(0, -'.labels.json'.length)),
  );
}

function artifactKind(name) {
  if (name.endsWith('.cpuprofile')) return 'cpu-profile';
  if (name.endsWith('.labels.json')) return 'labels';
  return null;
}
