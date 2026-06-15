/**
 * scope-access — the host-plane datastore accessors. `getProjectDatastore`
 * converts the internal DATASTORE_OUTSIDE_PROJECT SystemError into a
 * user-actionable ConfigurationError (exit 2) so callers of the documented
 * ToolCliContext seams never see a raw SYSTEM.* code; any other failure
 * propagates unchanged. Driven by a scope whose datastore thunk throws.
 */

import { SystemError } from '@opensip-cli/core';
import { makeTestScope, withScope } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { getProjectDatastore } from '../scope-access.js';

import type { DataStore } from '@opensip-cli/datastore';

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
    const other = new SystemError('disk exploded', { code: 'SYSTEM.DATASTORE.IO' });
    await withScope(scopeThrowing(other), () => {
      expect(() => getProjectDatastore()).toThrow('disk exploded');
    });
  });
});
