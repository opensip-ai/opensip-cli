import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeFailure } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const globSync = vi.hoisted(() => vi.fn<() => string[]>());

vi.mock('glob', () => ({
  glob: { sync: globSync },
  Ignore: class MockIgnore {
    ignored(): boolean {
      return false;
    }

    childrenIgnored(): boolean {
      return false;
    }
  },
}));

import { createDiscover } from '../discover.js';

function nativeError(code: string): Error {
  return Object.assign(new Error(`private source path failed with ${code}`), { code });
}

function captureFailure(run: () => unknown): ReturnType<typeof normalizeFailure> {
  try {
    run();
  } catch (error) {
    return normalizeFailure(error);
  }
  throw new Error('Expected discovery to fail');
}

describe('createDiscover — failure classification', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-disc-failure-'));
    globSync.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function discover(): ReturnType<typeof createDiscover> {
    return createDiscover({
      extension: 'go',
      excludedDirGlobs: [],
      configCandidates: [],
      languageId: 'go',
    });
  }

  it('preserves the Core permission definition for a native source-walk failure', () => {
    globSync.mockImplementation(() => {
      throw nativeError('EACCES');
    });

    const failure = captureFailure(() => discover()({ diagnosticIntent: 'quiet', cwd: dir }));

    expect(failure.code).toBe('CORE.SYSTEM.PERMISSION');
    expect(failure.message).toBe('Graph source discovery failed.');
    expect(failure.metadata).toMatchObject({
      condition: 'source-walk',
      errno: 'EACCES',
      language: 'go',
    });
  });

  it('uses the Graph adapter definition for an otherwise unclassified walk failure', () => {
    globSync.mockImplementation(() => {
      throw nativeError('ELOOP');
    });

    const failure = captureFailure(() => discover()({ diagnosticIntent: 'quiet', cwd: dir }));

    expect(failure.code).toBe('GRAPH.ADAPTER.DISCOVERY_FAILED');
    expect(failure.metadata).toMatchObject({
      condition: 'source-walk',
      errno: 'ELOOP',
      language: 'go',
    });
  });

  it('does not mix an unresolved project-root spelling with normalized file paths', () => {
    const failure = captureFailure(() =>
      discover()({ diagnosticIntent: 'quiet', cwd: join(dir, 'missing') }),
    );

    expect(failure.code).toBe('NOT_FOUND');
    expect(failure.metadata).toMatchObject({
      condition: 'project-root-realpath',
      errno: 'ENOENT',
      language: 'go',
    });
    expect(globSync).not.toHaveBeenCalled();
  });
});
