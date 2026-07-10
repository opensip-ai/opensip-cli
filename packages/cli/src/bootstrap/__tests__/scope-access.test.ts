/**
 * scope-access — the host-plane datastore accessors. `getProjectDatastore`
 * converts the internal DATASTORE_OUTSIDE_PROJECT SystemError into a
 * user-actionable ConfigurationError (exit 2) so callers of the documented
 * ToolCliContext seams never see a raw SYSTEM.* code; any other failure
 * propagates unchanged. Driven by a scope whose datastore thunk throws.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SystemError, resolveProjectPaths, type ProjectContext } from '@opensip-cli/core';
import { makeTestScope, withScope } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolStateRepo, type DataStore } from '@opensip-cli/datastore';

import { buildDatastoreThunk, getProjectDatastore } from '../scope-access.js';

/** A scope whose datastore thunk throws the given error. */
function scopeThrowing(error: unknown) {
  return makeTestScope({
    datastore: (() => {
      throw error;
    }) as unknown as () => DataStore,
  });
}

describe('getProjectDatastore', () => {
  it('converts DATASTORE_OUTSIDE_PROJECT into a user-actionable ConfigurationError', async () => {
    const outside = new SystemError('no datastore outside a project', {
      code: 'SYSTEM.BOOTSTRAP.DATASTORE_OUTSIDE_PROJECT',
    });
    await withScope(scopeThrowing(outside), () => {
      expect(() => getProjectDatastore()).toThrow(/requires an OpenSIP CLI project/);
      try {
        getProjectDatastore();
      } catch (error) {
        expect((error as { code?: string }).code).toBe('CONFIGURATION.REQUIRES_PROJECT');
      }
    });
  });

  it('propagates any other datastore error unchanged', async () => {
    const other = new SystemError('disk exploded', {
      code: 'SYSTEM.DATASTORE.IO',
    });
    await withScope(scopeThrowing(other), () => {
      expect(() => getProjectDatastore()).toThrow('disk exploded');
    });
  });
});

describe('buildDatastoreThunk lifecycle', () => {
  let root: string;
  const project = (): ProjectContext => ({
    cwd: root,
    cwdExplicit: false,
    projectRoot: root,
    configPath: join(root, 'opensip-cli.config.yml'),
    walkedUp: 0,
    scope: 'project',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opensip-dsthunk-'));
    mkdirSync(resolveProjectPaths(root).runtimeDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('caches the open store; dispose() closes it so the next access reopens', () => {
    const thunk = buildDatastoreThunk(project());
    const first = thunk();
    expect(thunk()).toBe(first); // cached on subsequent access

    thunk.dispose();
    // Public repository operation on the closed handle must fail (no raw
    // transaction escape on DataStore — ADR-0145 / opaque handle).
    const closedRepo = new ToolStateRepo(first);
    expect(() => closedRepo.get('tool', 'k')).toThrow();
    // ...and the next access transparently reopens a fresh connection.
    const second = thunk();
    expect(second).not.toBe(first);
    thunk.dispose();
  });

  it('dispose() is a no-op when the store was never opened', () => {
    expect(() => buildDatastoreThunk(project()).dispose()).not.toThrow();
  });
});
