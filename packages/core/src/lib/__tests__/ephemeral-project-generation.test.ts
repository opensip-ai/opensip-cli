import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveGenerationDigest } from '../ephemeral-project-generation.js';

describe('ephemeral project generation facts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ephemeral-project-generation-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects non-directory roots and unreliable gitfile forms', () => {
    const regularFile = join(root, 'regular-file');
    writeFileSync(regularFile, 'content');
    expect(resolveGenerationDigest(regularFile)).toBeUndefined();

    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const dotGit = join(projectDir, '.git');

    writeFileSync(dotGit, 'x'.repeat(4097));
    expect(resolveGenerationDigest(projectDir)).toBeUndefined();

    writeFileSync(dotGit, 'gitdir: target\u0000suffix');
    expect(resolveGenerationDigest(projectDir)).toBeUndefined();

    const gitTargetFile = join(root, 'git-target-file');
    writeFileSync(gitTargetFile, 'not a directory');
    writeFileSync(dotGit, `gitdir: ${gitTargetFile}`);
    expect(resolveGenerationDigest(projectDir)).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('rejects an unresolved git directory link', () => {
    const projectDir = join(root, 'linked-project');
    mkdirSync(projectDir);
    symlinkSync(join(root, 'missing-gitdir'), join(projectDir, '.git'));

    expect(resolveGenerationDigest(projectDir)).toBeUndefined();
  });

  it('binds both relative gitfiles and direct git directories', () => {
    const relativeProject = join(root, 'relative-project');
    const relativeGitDir = join(root, 'relative-gitdir');
    mkdirSync(relativeProject);
    mkdirSync(relativeGitDir);
    writeFileSync(join(relativeProject, '.git'), 'gitdir: ../relative-gitdir');

    const relativeDigest = resolveGenerationDigest(relativeProject);
    expect(relativeDigest).toMatch(/^[a-f0-9]{64}$/u);

    const directProject = join(root, 'direct-project');
    mkdirSync(join(directProject, '.git'), { recursive: true });
    const directDigest = resolveGenerationDigest(directProject);
    expect(directDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(directDigest).not.toBe(relativeDigest);
  });
});
