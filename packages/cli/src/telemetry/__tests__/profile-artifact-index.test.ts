import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProfileArtifactIndex,
  discardProfileArtifacts,
  writeCpuProfileArtifact,
  writeProfileArtifactLabels,
  type ProfileArtifactMetadata,
} from '../profile-artifact-index.js';

const STARTED_AT = new Date('2026-07-13T12:34:56.789Z');

describe('profile artifact index', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opensip-profile-index-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function metadata(overrides: Partial<Parameters<typeof createProfileArtifactIndex>[0]> = {}) {
    return createProfileArtifactIndex({
      baseDir: join(root, 'profiles'),
      command: 'fit',
      runId: 'RUN_TEST',
      startedAt: STARTED_AT,
      processId: 1234,
      uniqueSuffix: 'abc123',
      ...overrides,
    });
  }

  it('creates deterministic content-free metadata directly beneath the selected directory', () => {
    const artifacts = metadata();
    const selected = join(root, 'profiles');

    expect(artifacts.directory).toBe(selected);
    expect(artifacts.containmentRoot).toBe(root);
    expect(dirname(artifacts.profilePath)).toBe(selected);
    expect(dirname(artifacts.labelsPath)).toBe(selected);
    expect(basename(artifacts.profilePath)).toBe(
      'opensip-profile-2026-07-13T12-34-56-789Z-fit-RUN_TEST-p1234-abc123.cpuprofile',
    );
    expect(artifacts.labels).toEqual({
      service: 'opensip-cli',
      runId: 'RUN_TEST',
      command: 'fit',
    });
    expect(artifacts.startedAt).toBe(STARTED_AT.toISOString());
    expect(artifacts.status).toBe('reserved');
    expect(JSON.stringify(artifacts)).not.toContain('nodes');
  });

  it('rejects a symlinked artifact directory instead of writing through it', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'profiles'), process.platform === 'win32' ? 'junction' : 'dir');
    const artifacts = metadata();

    expect(() => writeProfileArtifactLabels(artifacts)).toThrow('not a real directory');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('canonicalizes a trusted symlinked containment root', () => {
    const actualRoot = join(root, 'actual');
    const aliasRoot = join(root, 'alias');
    mkdirSync(actualRoot);
    symlinkSync(actualRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const artifacts = metadata({
      baseDir: join(aliasRoot, 'profiles'),
      containmentRoot: aliasRoot,
    });

    writeProfileArtifactLabels(artifacts);

    expect(artifacts.containmentRoot).toBe(realpathSync(aliasRoot));
    expect(artifacts.directory).toBe(join(realpathSync(aliasRoot), 'profiles'));
    expect(existsSync(artifacts.labelsPath)).toBe(true);
  });

  it('returns new complete metadata only after publication', () => {
    const reserved = metadata();
    const completedAt = new Date('2026-07-13T12:35:01.000Z');
    writeProfileArtifactLabels(reserved);
    const complete = writeCpuProfileArtifact(reserved, { nodes: [] }, completedAt);

    expect(existsSync(reserved.profilePath)).toBe(true);
    expect(complete).not.toBe(reserved);
    expect(complete).toMatchObject({
      directory: reserved.directory,
      profilePath: reserved.profilePath,
      labelsPath: reserved.labelsPath,
      status: 'complete',
      completedAt: completedAt.toISOString(),
    });
    expect(reserved.status).toBe('reserved');
    expect(reserved).not.toHaveProperty('completedAt');
  });

  it.each([
    ['subcommand', 'graph lookup'],
    ['separator', String.raw`graph/../../secrets\lookup`],
    ['spaces', '  fit   changed  '],
    ['unicode', 'gráph 🔥 lookup'],
  ])('bounds and slugs a %s command without escaping the selected directory', (_name, command) => {
    const artifacts = metadata({
      command,
      runId: String.raw`../../outside\RUN_${'x'.repeat(300)}`,
    });
    const selected = join(root, 'profiles');

    expect(dirname(artifacts.profilePath)).toBe(selected);
    expect(dirname(artifacts.labelsPath)).toBe(selected);
    expect(basename(artifacts.profilePath)).not.toContain('..');
    expect(basename(artifacts.profilePath)).not.toContain('/');
    expect(artifacts.labels.command.length).toBeLessThanOrEqual(128);
    expect(artifacts.labels.runId.length).toBeLessThanOrEqual(128);
  });

  it('uses exclusive owner-only writes so a collision cannot overwrite artifacts', () => {
    const artifacts = metadata();
    writeProfileArtifactLabels(artifacts);
    const originalLabels = readFileSync(artifacts.labelsPath, 'utf8');

    expect(statSync(dirname(artifacts.labelsPath)).mode & 0o777).toBe(0o700);
    expect(statSync(artifacts.labelsPath).mode & 0o777).toBe(0o600);
    expect(() => writeProfileArtifactLabels(artifacts)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(readFileSync(artifacts.labelsPath, 'utf8')).toBe(originalLabels);

    writeCpuProfileArtifact(artifacts, { nodes: [{ id: 1 }] });
    const originalProfile = readFileSync(artifacts.profilePath, 'utf8');
    expect(statSync(artifacts.profilePath).mode & 0o777).toBe(0o600);
    expect(() => writeCpuProfileArtifact(artifacts, { nodes: [{ id: 2 }] })).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(readFileSync(artifacts.profilePath, 'utf8')).toBe(originalProfile);
    expect(readdirSync(artifacts.directory).some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('does not publish or strand a temporary file when serialization fails', () => {
    const artifacts = metadata();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => writeCpuProfileArtifact(artifacts, cyclic)).toThrow();
    expect(existsSync(artifacts.profilePath)).toBe(false);
    expect(existsSync(artifacts.directory)).toBe(false);
  });

  it('removes only the indexed pair during failed-start cleanup', () => {
    const artifacts = metadata();
    writeProfileArtifactLabels(artifacts);
    writeCpuProfileArtifact(artifacts, { nodes: [] });
    const unrelated = join(root, 'profiles', 'keep.txt');
    writeFileSync(unrelated, 'keep', 'utf8');

    discardProfileArtifacts(artifacts);

    expect(() => statSync(artifacts.labelsPath)).toThrow();
    expect(() => statSync(artifacts.profilePath)).toThrow();
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
  });

  it('rejects invalid construction and mismatched forged metadata', () => {
    expect(() => metadata({ baseDir: '   ' })).toThrow('directory is empty');
    expect(() => metadata({ processId: 0 })).toThrow('positive safe integer');
    expect(() => metadata({ startedAt: new Date(Number.NaN) })).toThrow('valid date');

    const valid = metadata();
    const sameDirectoryForgery = {
      ...valid,
      profilePath: join(valid.directory, 'victim.cpuprofile'),
      labelsPath: join(valid.directory, 'victim.labels.json'),
    } as unknown as ProfileArtifactMetadata;
    expect(() => writeProfileArtifactLabels(sameDirectoryForgery)).toThrow(
      'was not created by the artifact index',
    );

    const inheritedForgery = Object.create(valid) as ProfileArtifactMetadata;
    expect(() => discardProfileArtifacts(inheritedForgery)).toThrow(
      'was not created by the artifact index',
    );

    const proxiedForgery = new Proxy(valid, {});
    expect(() => writeProfileArtifactLabels(proxiedForgery)).toThrow(
      'was not created by the artifact index',
    );
  });
});
