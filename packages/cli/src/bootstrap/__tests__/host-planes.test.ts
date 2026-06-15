/**
 * host-planes — the host-owned Governance / Audit / Entitlements bag attached
 * to `ToolCliContext.hostPlanes` (ADR-0042). Every sub-plane method is a
 * read-modify-write over namespaced keys in the host-owned `tool_state` table
 * (via ToolStateRepo); this round-trips each against an in-memory backend,
 * including the optional-logger branch and the default-allow / default-entitled
 * fallbacks. The lazy repo + Date.now() stamps are exercised by construction.
 */

import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHostPlanes } from '../host-planes.js';

import type { Logger } from '@opensip-cli/core';

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

function planes(logger?: Logger) {
  return buildHostPlanes({ getDatastore: () => ds, ...(logger ? { logger } : {}) });
}

describe('host-planes — governance', () => {
  it('records an installation and reads it back, then blocks/unblocks gate checkAllowed', async () => {
    const { governance } = planes();
    expect(await governance.getGovernanceState('fit')).toBeUndefined();

    await governance.recordInstallation('fit', { spec: '@x/fit' });
    const state = (await governance.getGovernanceState('fit')) as Record<string, unknown>;
    expect(state.installed).toBe(true);
    expect(state.lastInstallation).toEqual({ spec: '@x/fit' });

    // No block recorded yet → checkAllowed defaults to allow.
    expect(await governance.checkAllowed('fit', { action: 'run' })).toBe(true);

    await governance.setBlock('fit', true, 'policy violation');
    expect(await governance.checkAllowed('fit', { action: 'run' })).toBe(false);

    await governance.setBlock('fit', false);
    expect(await governance.checkAllowed('fit', { action: 'run' })).toBe(true);
  });

  it('appends approval decisions cumulatively', async () => {
    const { governance } = planes();
    await governance.recordApprovalDecision('fit', { by: 'a', approved: true });
    await governance.recordApprovalDecision('fit', { by: 'b', approved: false });
    const state = (await governance.getGovernanceState('fit')) as { approvals: unknown[] };
    expect(state.approvals).toHaveLength(2);
  });

  it('defaults checkAllowed to allow for a tool with no governance record', async () => {
    expect(await planes().governance.checkAllowed('never-seen', {})).toBe(true);
  });

  it('queryAudit returns an empty list with no entries and listForProject is empty (first-cut)', async () => {
    const { governance } = planes();
    expect(await governance.queryAudit('fit')).toEqual([]);
    expect(await governance.listForProject('/proj')).toEqual([]);
  });

  it('emits a debug log when a logger is supplied (install-recorded)', async () => {
    const debug = vi.fn();
    await planes({ debug } as unknown as Logger).governance.recordInstallation('fit', {});
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.governance.install-recorded', tool: 'fit' }),
    );
  });
});

describe('host-planes — audit', () => {
  it('appends timestamped entries and queries them back', async () => {
    const { audit } = planes();
    expect(await audit.query('fit')).toEqual([]);
    await audit.append('fit', { action: 'run', detail: 'x' });
    await audit.append('fit', { action: 'gate' });
    const entries = (await audit.query('fit')) as Record<string, unknown>[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ action: 'run' });
    expect(typeof entries[0]?.ts).toBe('number');
  });

  it('exportForCloud returns the current log for the given tool, empty for an unknown arg', async () => {
    const { audit } = planes();
    await audit.append('fit', { action: 'run' });
    const exported = (await audit.exportForCloud('fit')) as { entries: unknown[] };
    expect(exported).toEqual({ entries: expect.any(Array) });
    expect(exported.entries).toHaveLength(1);
    // No/empty tool arg → empty export, no throw.
    expect(await audit.exportForCloud()).toEqual({ entries: [] });
  });

  it('emits a debug log on append when a logger is supplied', async () => {
    const debug = vi.fn();
    await planes({ debug } as unknown as Logger).audit.append('fit', { action: 'run' });
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.audit.append', tool: 'fit' }),
    );
  });
});

describe('host-planes — entitlements', () => {
  it('defaults to entitled for a tool with no recorded entitlements', async () => {
    expect(await planes().entitlements.check('fit')).toEqual({ entitled: true, source: 'default' });
  });

  it('records usage and returns the recorded state on a subsequent check', async () => {
    const { entitlements } = planes();
    await entitlements.recordUsage('fit', { units: 5 });
    const state = (await entitlements.check('fit')) as Record<string, unknown>;
    expect(state.lastUsage).toEqual({ units: 5 });
    expect(state.entitled).toBeUndefined(); // a recorded blob shadows the default
  });

  it('reads the license state out of the entitlements blob', async () => {
    const { entitlements } = planes();
    expect(await entitlements.getLicenseState('fit')).toBeUndefined();
    await entitlements.recordUsage('fit', { units: 1 });
    // recordUsage wrote a blob but no license key yet.
    expect(await entitlements.getLicenseState('fit')).toBeUndefined();
  });
});
