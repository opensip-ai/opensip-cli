import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, RunScope, SystemError, runWithScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWriteArtifactSeam } from '../artifact-seams.js';

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
