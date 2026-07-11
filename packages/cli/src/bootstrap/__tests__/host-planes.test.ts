/**
 * host-planes — the host-owned Governance / Audit / Entitlements bag attached
 * to `ToolCliContext.hostPlanes` (ADR-0042). Every sub-plane method is a
 * read-modify-write over namespaced keys in the host-owned `tool_state` table
 * (via ToolStateRepo); this round-trips each against an in-memory backend,
 * including the optional-logger branch and the default-allow / default-entitled
 * fallbacks. The lazy repo + Date.now() stamps are exercised by construction.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataStoreFactory, ToolStateRepo, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHostPlanes } from '../host-planes.js';

import type { HostAudit, HostEntitlements, HostGovernance, Logger } from '@opensip-cli/core';

let ds: DataStore;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../datastore/migrations', import.meta.url));

function copyPreHostPlaneMigrations(destination: string): void {
  cpSync(MIGRATIONS_DIR, destination, { recursive: true });
  rmSync(join(destination, '0009_host_plane_namespace.sql'));
  rmSync(join(destination, 'meta', '0009_snapshot.json'));
  const journalPath = join(destination, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== '0009_host_plane_namespace');
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

function planes(logger?: Logger): {
  governance: HostGovernance;
  audit: HostAudit;
  entitlements: HostEntitlements;
} {
  const built = buildHostPlanes({
    getDatastore: () => ds,
    ...(logger ? { logger } : {}),
  });
  // buildHostPlanes always constructs all three planes; narrow the tool-facing
  // optional shape to the concrete triple these tests exercise.
  return built as {
    governance: HostGovernance;
    audit: HostAudit;
    entitlements: HostEntitlements;
  };
}

describe('host-planes — governance', () => {
  it('reads a legacy host row after DataStoreFactory applies migration 0009', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-plane-cli-parity-'));
    const oldMigrations = join(root, 'migrations-0008');
    const dbPath = join(root, 'datastore.sqlite');
    copyPreHostPlaneMigrations(oldMigrations);
    let migrated: DataStore | undefined;
    try {
      const legacy = DataStoreFactory.open({
        backend: 'sqlite',
        path: dbPath,
        migrationsFolder: oldMigrations,
      });
      new ToolStateRepo(legacy).put('fit', 'governance', { migrated: true });
      legacy.close();

      migrated = DataStoreFactory.open({ backend: 'sqlite', path: dbPath });
      const hostPlanes = buildHostPlanes({
        getDatastore: () => migrated!,
      });
      await expect(hostPlanes?.governance?.getGovernanceState('fit')).resolves.toEqual({
        migrated: true,
      });

      const { hostPlaneStateIdentity } = await import('../host-plane-state.js');
      expect(new ToolStateRepo(migrated).get(hostPlaneStateIdentity('fit'), 'governance')).toEqual({
        migrated: true,
      });
      expect(new ToolStateRepo(migrated).get('fit', 'governance')).toEqual({
        migrated: true,
      });
    } finally {
      migrated?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records an installation and reads it back, then blocks/unblocks gate checkAllowed', async () => {
    const { governance } = planes();
    expect(await governance.getGovernanceState('fit')).toBeUndefined();

    await governance.recordInstallation('fit', { spec: '@x/fit' });
    const state = (await governance.getGovernanceState('fit')) as Record<string, unknown>;
    expect(state.installed).toBe(true);
    expect(state.lastInstallation).toEqual({ spec: '@x/fit' });

    // No block recorded yet → checkAllowed defaults to allow.
    expect(await governance.checkAllowed('fit', 'run-simulation')).toBe(true);

    await governance.setBlock('fit', true, 'policy violation');
    expect(await governance.checkAllowed('fit', 'run-simulation')).toBe(false);

    await governance.setBlock('fit', false);
    expect(await governance.checkAllowed('fit', 'run-simulation')).toBe(true);
  });

  it('appends approval decisions cumulatively', async () => {
    const { governance } = planes();
    await governance.recordApprovalDecision('fit', { by: 'a', approved: true });
    await governance.recordApprovalDecision('fit', {
      by: 'b',
      approved: false,
    });
    const state = (await governance.getGovernanceState('fit')) as {
      approvals: unknown[];
    };
    expect(state.approvals).toHaveLength(2);
  });

  it('defaults checkAllowed to allow for a tool with no governance record', async () => {
    expect(await planes().governance.checkAllowed('never-seen', 'run-simulation')).toBe(true);
  });

  it('queryAudit returns an empty list with no entries', async () => {
    const { governance } = planes();
    expect(await governance.queryAudit('fit')).toEqual([]);
  });

  it('does not expose unbound listForProject (ADR-0146)', () => {
    const { governance } = planes();
    expect(governance).not.toHaveProperty('listForProject');
  });

  it('emits a debug log when a logger is supplied (install-recorded)', async () => {
    const debug = vi.fn();
    await planes({ debug } as unknown as Logger).governance.recordInstallation('fit', {});
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.governance.install-recorded',
        tool: 'fit',
      }),
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

  it('does not expose unbound exportForCloud (ADR-0146)', () => {
    const { audit } = planes();
    expect(audit).not.toHaveProperty('exportForCloud');
  });

  it('stores under reserved host-plane identity, not ordinary tool key', async () => {
    const { ToolStateRepo } = await import('@opensip-cli/datastore');
    const { hostPlaneStateIdentity } = await import('../host-plane-state.js');
    const { governance } = planes();
    await governance.recordInstallation('fit', { spec: '@x/fit' });
    const repo = new ToolStateRepo(ds);
    // Ordinary tool key must remain empty (no collision with tool-owned state).
    expect(repo.get('fit', 'governance')).toBeUndefined();
    // Reserved identity holds the host compatibility blob.
    expect(repo.get(hostPlaneStateIdentity('fit'), 'governance')).toMatchObject({
      installed: true,
    });
  });

  it('emits a debug log on append when a logger is supplied', async () => {
    const debug = vi.fn();
    await planes({ debug } as unknown as Logger).audit.append('fit', {
      action: 'run',
    });
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.audit.append', tool: 'fit' }),
    );
  });
});

describe('host-planes — entitlements', () => {
  it('defaults to entitled for a tool with no recorded entitlements', async () => {
    expect(await planes().entitlements.check('fit')).toEqual({
      entitled: true,
      source: 'default',
    });
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
