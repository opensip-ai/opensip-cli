import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { INVENTORY_SNAPSHOT_INVALID_REASON } from './inventory-helpers.js';
import { buildProjectInventory } from './inventory.js';

type ContractsModule = Record<string, unknown> & {
  readonly projectInventorySnapshotSchema: {
    safeParse: (value: unknown) => { success: boolean };
  };
};

const rejectSnapshots = vi.hoisted(() => ({ enabled: false }));

vi.mock('@opensip-cli/contracts', async (importOriginal) => {
  const actual = await importOriginal<ContractsModule>();
  return {
    ...actual,
    projectInventorySnapshotSchema: {
      ...actual.projectInventorySnapshotSchema,
      safeParse: (value: unknown) =>
        rejectSnapshots.enabled
          ? { success: false as const, error: new Error('fixture contract rejection') }
          : actual.projectInventorySnapshotSchema.safeParse(value),
    },
  };
});

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-degradation-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  roots.push(root);
  return root;
}

afterEach(() => {
  rejectSnapshots.enabled = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildProjectInventory snapshot contract failure', () => {
  it('withdraws an unpublishable projection instead of throwing out of the build', async () => {
    const root = tempRoot();
    rejectSnapshots.enabled = true;

    // The success path parses the assembled snapshot. A rejection there is defence in
    // depth (the producers are bounded to the contract), but if it ever fires it must not
    // turn a completed scan into a raw throw from a substrate that degrades everywhere
    // else. The withdrawal is itself coded evidence.
    const inventory = await buildProjectInventory({ projectRoot: root, configIdentity: 'cfg' });

    expect(inventory.snapshot.coverage.status).toBe('unavailable');
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_SNAPSHOT_INVALID_REASON);
    expect(inventory.snapshot.files).toEqual([]);
    expect(inventory.snapshot.packages).toEqual([]);
    expect(inventory.fileByPath.size).toBe(0);
  });

  it('publishes the projection normally when the contract accepts it', async () => {
    const root = tempRoot();

    const inventory = await buildProjectInventory({ projectRoot: root, configIdentity: 'cfg' });

    expect(inventory.snapshot.coverage.reasonCodes).not.toContain(
      INVENTORY_SNAPSHOT_INVALID_REASON,
    );
  });
});
