import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ConfigurationError,
  RunScope,
  SystemError,
  resolveProjectPaths,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnsureArtifactDirSeam, createWriteArtifactSeam } from '../artifact-seams.js';

import type { Logger, ProjectContext } from '@opensip-cli/core';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createWriteArtifactSeam', () => {
  let dir = '';

  afterEach(() => {
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes bytes through the host-owned atomic artifact writer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const target = join(dir, 'nested', 'catalog.json');
    const writeArtifact = createWriteArtifactSeam(makeLogger());

    await writeArtifact(target, '{"ok":true}\n');

    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
  });

  it('works inside a scope without projectContext', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const target = join(dir, 'catalog.json');
    const scope = new RunScope({
      logger: makeLogger(),
      runId: 'r-artifact-seam',
    });
    const writeArtifact = createWriteArtifactSeam(makeLogger());

    await runWithScope(scope, () => writeArtifact(target, 'plain bytes\n'));

    expect(readFileSync(target, 'utf8')).toBe('plain bytes\n');
  });

  it('rejects a directory target as a configuration error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const target = join(dir, 'already-dir');
    mkdirSync(target);

    await expect(createWriteArtifactSeam(makeLogger())(target, 'nope')).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('derives cwdBasename from the scope projectContext when present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const target = join(dir, 'catalog.json');
    const projectContext: ProjectContext = {
      cwd: dir,
      cwdExplicit: false,
      projectRoot: dir,
      configPath: undefined,
      walkedUp: 0,
      scope: 'project',
    };
    const scope = new RunScope({
      logger: makeLogger(),
      runId: 'r-pc',
      projectContext,
    });
    const writeArtifact = createWriteArtifactSeam(makeLogger());

    await runWithScope(scope, () => writeArtifact(target, 'scoped\n'));

    expect(readFileSync(target, 'utf8')).toBe('scoped\n');
  });

  it('prunes old per-tool run dirs after writing inside the artifact store', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const { artifactsDir } = resolveProjectPaths(dir);
    const toolDir = join(artifactsDir, 'gitleaks');
    // Two pre-existing (older) run dirs the new write should evict at keep=1.
    for (const [i, name] of ['run-old-1', 'run-old-2'].entries()) {
      mkdirSync(join(toolDir, name), { recursive: true });
      const seconds = 1_700_000_000 + i * 100;
      utimesSync(join(toolDir, name), seconds, seconds);
    }
    const projectContext: ProjectContext = {
      cwd: dir,
      cwdExplicit: false,
      projectRoot: dir,
      configPath: undefined,
      walkedUp: 0,
      scope: 'project',
    };
    const scope = new RunScope({ logger: makeLogger(), runId: 'run-new', projectContext });
    const target = join(toolDir, 'run-new', 'gitleaks.json');
    const writeArtifact = createWriteArtifactSeam(makeLogger(), { retentionKeep: 1 });

    await runWithScope(scope, () => writeArtifact(target, '[]\n'));

    // Only the just-written (newest) run dir survives.
    expect(readdirSync(toolDir).sort()).toEqual(['run-new']);
  });

  it('does not prune for a write outside the artifact store', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const { artifactsDir } = resolveProjectPaths(dir);
    const toolDir = join(artifactsDir, 'gitleaks');
    mkdirSync(join(toolDir, 'run-old'), { recursive: true });
    const projectContext: ProjectContext = {
      cwd: dir,
      cwdExplicit: false,
      projectRoot: dir,
      configPath: undefined,
      walkedUp: 0,
      scope: 'project',
    };
    const scope = new RunScope({ logger: makeLogger(), runId: 'r-outside', projectContext });
    // A generic write outside `.runtime/artifacts` (e.g. graph --catalog-output).
    const target = join(dir, 'catalog.json');
    const writeArtifact = createWriteArtifactSeam(makeLogger(), { retentionKeep: 1 });

    await runWithScope(scope, () => writeArtifact(target, '{}\n'));

    expect(readFileSync(target, 'utf8')).toBe('{}\n');
    // The unrelated artifact-store run dir is untouched.
    expect(readdirSync(toolDir)).toEqual(['run-old']);
  });

  it('wraps a non-ToolError write failure as a SystemError', async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-seam-'));
    const regularFile = join(dir, 'a-file');
    writeFileSync(regularFile, 'x');
    // The parent path component is a regular file, so stat throws ENOTDIR
    // (not ENOENT) — a non-ToolError that surfaces as a wrapped SystemError.
    const target = join(regularFile, 'sub', 'catalog.json');

    await expect(createWriteArtifactSeam(makeLogger())(target, 'nope')).rejects.toBeInstanceOf(
      SystemError,
    );
  });
});

describe('createEnsureArtifactDirSeam (A1/A7)', () => {
  let dir = '';

  afterEach(() => {
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('creates the parent dir of the artifact path, recursively, at owner-only 0o700', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-dir-'));
    const artifact = join(dir, 'a', 'b', 'RUN_x', 'report.json');
    const ensureArtifactDir = createEnsureArtifactDirSeam(makeLogger());

    await ensureArtifactDir(artifact);

    const runDir = dirname(artifact);
    const stat = statSync(runDir);
    expect(stat.isDirectory()).toBe(true);
    // A7: the per-run dir is 0o700 so a scanner's default-umask (0644) report
    // inside it is not world-traversable before the host re-writes it at 0600.
    expect(stat.mode & 0o777).toBe(0o700);
    // It does NOT create the artifact file itself — only the directory.
    expect(() => statSync(artifact)).toThrow();
  });

  it('is idempotent for a pre-existing directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-dir-'));
    const artifact = join(dir, 'runs', 'report.json');
    const ensureArtifactDir = createEnsureArtifactDirSeam(makeLogger());

    await ensureArtifactDir(artifact);
    await expect(ensureArtifactDir(artifact)).resolves.toBeUndefined();
    expect(statSync(dirname(artifact)).isDirectory()).toBe(true);
  });

  it('wraps a failure (parent path is a regular file) as a SystemError', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-dir-'));
    const regularFile = join(dir, 'a-file');
    writeFileSync(regularFile, 'x');
    // dirname is `<regularFile>/sub` whose parent is a file ⇒ ENOTDIR.
    const artifact = join(regularFile, 'sub', 'report.json');
    const ensureArtifactDir = createEnsureArtifactDirSeam(makeLogger());

    await expect(ensureArtifactDir(artifact)).rejects.toBeInstanceOf(SystemError);
  });
});
