import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, RunScope, runWithScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWriteArtifactSeam } from '../artifact-seams.js';

import type { Logger } from '@opensip-cli/core';

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
    const scope = new RunScope({ logger: makeLogger(), runId: 'r-artifact-seam' });
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
});
