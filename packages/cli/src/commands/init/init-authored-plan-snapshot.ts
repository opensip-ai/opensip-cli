import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { classifyAuthoredPathPosture } from './authored-path-mode.js';
import {
  inspectExistingSnapshotPath,
  isOpaqueGeneratedSnapshotEntry,
  sameSnapshotStat,
  stableSnapshotDirectoryNames,
  validateSafeSnapshotStat,
  type SnapshotBudget,
} from './init-authored-plan-snapshot-fs.js';
import {
  authoredPlanFailure,
  caseFoldPath,
  compareUtf8,
  isRuntimeAuthoredPath,
  normalizeProjectRelativePath,
} from './init-authored-plan-types.js';

import type {
  InitAuthoredSnapshot,
  InitAuthoredSnapshotHooks,
  InitAuthoredSnapshotRecord,
  InitAuthoredWorkingDirState,
  ReadInitAuthoredSnapshotInput,
} from './init-authored-plan-types.js';
import type { BigIntStats } from 'node:fs';

export {
  openInitAuthoredSnapshotPath,
  type InitAuthoredSnapshotOpenDependencies,
} from './init-authored-plan-snapshot-fs.js';

function addRecord(
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  record: InitAuthoredSnapshotRecord,
): void {
  const prior = folded.get(caseFoldPath(record.path));
  if (prior !== undefined && prior !== record.path) {
    authoredPlanFailure(`case-folded path collision between '${prior}' and '${record.path}'`);
  }
  folded.set(caseFoldPath(record.path), record.path);
  const existing = records.get(record.path);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
    authoredPlanFailure(`${record.path} changed between snapshot observations`);
  }
  records.set(record.path, record);
}

function walkAuthoredTree(
  root: string,
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  budget: SnapshotBudget,
  opaquePaths: Set<string>,
  hooks: InitAuthoredSnapshotHooks | undefined,
): void {
  const visit = (relativePath: string): void => {
    const absolutePath = join(root, ...relativePath.split('/'));
    const record = inspectExistingSnapshotPath(absolutePath, relativePath, budget, hooks);
    addRecord(records, folded, record);
    if (!record.exists || record.type !== 'directory') return;
    const names = stableSnapshotDirectoryNames(absolutePath, relativePath, hooks);
    const localFolded = new Map<string, string>();
    for (const name of names) {
      const normalizedName = name.normalize('NFC');
      if (normalizedName !== name || name.includes('/') || name.includes('\\') || name === '..') {
        authoredPlanFailure(`${relativePath} contains a noncanonical entry name`);
      }
      const foldedName = caseFoldPath(name);
      const prior = localFolded.get(foldedName);
      if (prior !== undefined && prior !== name) {
        authoredPlanFailure(`case-folded sibling collision in ${relativePath}`);
      }
      localFolded.set(foldedName, name);
      const child = `${relativePath}/${name}`;
      if (isRuntimeAuthoredPath(child)) {
        const runtimeStat = inspectExistingSnapshotPath(
          join(root, ...child.split('/')),
          child,
          budget,
          hooks,
        );
        if (!runtimeStat.exists || runtimeStat.type !== 'directory') {
          authoredPlanFailure('opensip-cli/.runtime must be a real directory');
        }
        continue;
      }
      if (
        isOpaqueGeneratedSnapshotEntry(
          join(root, ...child.split('/')),
          normalizeProjectRelativePath(child),
          budget,
        )
      ) {
        opaquePaths.add(normalizeProjectRelativePath(child));
        continue;
      }
      visit(normalizeProjectRelativePath(child));
    }
  };

  const authoredRoot = join(root, 'opensip-cli');
  try {
    lstatSync(authoredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    authoredPlanFailure('could not inspect opensip-cli');
  }
  visit('opensip-cli');
}

function snapshotWorkingDirState(
  records: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  opaquePaths: ReadonlySet<string>,
): InitAuthoredWorkingDirState {
  const hasConfig = records.get('opensip-cli.config.yml')?.exists === true;
  const hasAuthoredDirectoryContent =
    opaquePaths.size > 0 ||
    [...records.values()].some(
      (record) =>
        record.exists &&
        record.path.startsWith('opensip-cli/') &&
        !isRuntimeAuthoredPath(record.path),
    );
  if (!hasConfig && !hasAuthoredDirectoryContent) return 'pristine';
  if (hasConfig && hasAuthoredDirectoryContent) return 'fully-initialized';
  return hasConfig ? 'partial-config-only' : 'partial-dir-only';
}

function observeTarget(
  root: string,
  relativePath: string,
  records: Map<string, InitAuthoredSnapshotRecord>,
  folded: Map<string, string>,
  budget: SnapshotBudget,
  hooks: InitAuthoredSnapshotHooks | undefined,
): void {
  if (records.has(relativePath)) return;
  const segments = relativePath.split('/');
  let parent = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const parentRelative = index === 0 ? '<project-root>' : segments.slice(0, index).join('/');
    const names = stableSnapshotDirectoryNames(parent, parentRelative, hooks);
    const exact = names.includes(segment);
    const colliding = names.find(
      (name) => name !== segment && caseFoldPath(name) === caseFoldPath(segment),
    );
    if (colliding !== undefined) {
      authoredPlanFailure(`case-folded path collision between '${colliding}' and '${segment}'`);
    }
    if (!exact) {
      addRecord(records, folded, {
        path: relativePath,
        exists: false,
        type: null,
        mode: null,
        digest: null,
        contentBase64: null,
      });
      return;
    }
    const currentRelative = segments.slice(0, index + 1).join('/');
    const absolutePath = join(parent, segment);
    if (index < segments.length - 1) {
      const ancestor = inspectExistingSnapshotPath(absolutePath, currentRelative, budget, hooks);
      if (!ancestor.exists || ancestor.type !== 'directory') {
        authoredPlanFailure(`${currentRelative} is not a directory`);
      }
      parent = absolutePath;
      continue;
    }
    addRecord(
      records,
      folded,
      inspectExistingSnapshotPath(absolutePath, relativePath, budget, hooks),
    );
  }
}

export function readInitAuthoredSnapshot(
  input: ReadInitAuthoredSnapshotInput,
): InitAuthoredSnapshot {
  const requestedRoot = resolve(input.projectRoot);
  let requestedStat: BigIntStats;
  try {
    requestedStat = lstatSync(requestedRoot, { bigint: true });
  } catch {
    authoredPlanFailure('project root is unreadable');
  }
  if (requestedStat.isSymbolicLink()) authoredPlanFailure('project root must not be a symlink');
  validateSafeSnapshotStat(requestedStat, 'directory', '<project-root>');
  const root = realpathSync(requestedRoot);
  const rootBefore = lstatSync(root, { bigint: true });
  if (!sameSnapshotStat(requestedStat, rootBefore))
    authoredPlanFailure('project root changed while opening');

  const records = new Map<string, InitAuthoredSnapshotRecord>();
  const folded = new Map<string, string>();
  const opaquePaths = new Set<string>();
  const budget: SnapshotBudget = { entries: 0, bytes: 0 };
  walkAuthoredTree(root, records, folded, budget, opaquePaths, input.hooks);
  const targets = [...new Set(input.targetPaths.map(normalizeProjectRelativePath))].sort(
    compareUtf8,
  );
  for (const target of targets) {
    observeTarget(root, target, records, folded, budget, input.hooks);
  }
  const rootAfter = lstatSync(root, { bigint: true });
  if (!sameSnapshotStat(rootBefore, rootAfter)) {
    authoredPlanFailure('project root changed while planning');
  }

  return {
    records: Object.freeze(
      [...records.values()].sort((left, right) => compareUtf8(left.path, right.path)),
    ),
    opaquePaths: Object.freeze([...opaquePaths].sort(compareUtf8)),
    workingDirState: snapshotWorkingDirState(records, opaquePaths),
    projectRootPosture: classifyAuthoredPathPosture(requestedStat.mode),
  };
}
