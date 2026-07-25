import {
  contextCoverageSchema,
  projectInventorySnapshotSchema,
  type FileFact,
} from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import {
  INVENTORY_CANCELLED_REASON,
  INVENTORY_DEADLINE_REASON,
  INVENTORY_SNAPSHOT_INVALID_REASON,
  REASON_CAP_REACHED,
} from './inventory-helpers.js';
import { emptyInventory, enforceSerializedBudget } from './inventory-snapshot.js';
import { MAX_COVERAGE_REASON_CODES } from './types.js';

import type { ProjectInventoryInput } from './types.js';

const INPUT: ProjectInventoryInput = { projectRoot: '/does-not-matter', configIdentity: 'cfg' };

/** Filler reasons that sort BEFORE every pinned reason, so naive truncation would drop them. */
function fillerReasons(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `aa-filler-${String(index).padStart(3, '0')}`);
}

function budgetCoverage(reasons: Iterable<string>, available = true) {
  return enforceSerializedBudget({
    configIdentity: 'cfg',
    manifests: [],
    packages: [],
    files: [] as readonly FileFact[],
    available,
    reasons: new Set(reasons),
    maximumBytes: 1024 * 1024,
  }).base.coverage;
}

describe('coverage reason-code cap', () => {
  it('mirrors the contract bound, so the producer cannot outgrow its own schema', () => {
    // If contracts ever widens or narrows the bound, this pins the mirror rather than
    // letting the producer drift into emitting a coverage object it cannot publish.
    expect(
      contextCoverageSchema.safeParse({
        status: 'partial',
        reasonCodes: fillerReasons(MAX_COVERAGE_REASON_CODES),
        observed: 0,
      }).success,
    ).toBe(true);
    expect(
      contextCoverageSchema.safeParse({
        status: 'partial',
        reasonCodes: fillerReasons(MAX_COVERAGE_REASON_CODES + 1),
        observed: 0,
      }).success,
    ).toBe(false);
  });

  it('caps an over-long reason set instead of emitting an unpublishable degradation', () => {
    const coverage = budgetCoverage(fillerReasons(200));

    expect(coverage.reasonCodes).toHaveLength(MAX_COVERAGE_REASON_CODES);
    expect(coverage.reasonCodes).toContain(REASON_CAP_REACHED);
    expect(contextCoverageSchema.safeParse(coverage).success).toBe(true);
  });

  it('leaves a reason set within the bound untouched and unreported', () => {
    const coverage = budgetCoverage(['file-cap-reached', 'manifest-read-failed']);

    expect(coverage.reasonCodes).toEqual(['file-cap-reached', 'manifest-read-failed']);
    expect(coverage.reasonCodes).not.toContain(REASON_CAP_REACHED);
  });

  it('deduplicates before measuring against the bound', () => {
    const coverage = budgetCoverage([...fillerReasons(10), ...fillerReasons(10)]);

    expect(coverage.reasonCodes).toHaveLength(10);
    expect(coverage.reasonCodes).not.toContain(REASON_CAP_REACHED);
  });
});

describe('cancelled runs stay distinguishable from capped runs (D7)', () => {
  it('retains the cancellation reason when truncation would otherwise drop it', () => {
    const cancelled = budgetCoverage([...fillerReasons(200), INVENTORY_CANCELLED_REASON]);
    const capped = budgetCoverage([...fillerReasons(200), 'file-cap-reached']);

    // Every filler sorts before `inventory-cancelled`, so an unpinned truncation would
    // silently publish an interrupted run as an ordinary capped one.
    expect(cancelled.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
    expect(capped.reasonCodes).not.toContain(INVENTORY_CANCELLED_REASON);
    expect(cancelled.reasonCodes).toHaveLength(MAX_COVERAGE_REASON_CODES);
    expect(capped.reasonCodes).toHaveLength(MAX_COVERAGE_REASON_CODES);
  });

  it('keeps an expired deadline separable from an operator interrupt', () => {
    const coverage = budgetCoverage([
      ...fillerReasons(200),
      INVENTORY_CANCELLED_REASON,
      INVENTORY_DEADLINE_REASON,
    ]);

    expect(coverage.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
    expect(coverage.reasonCodes).toContain(INVENTORY_DEADLINE_REASON);
  });

  it('never reports an interrupted run as complete', () => {
    expect(budgetCoverage([]).status).toBe('complete');
    expect(budgetCoverage(['file-cap-reached']).status).toBe('partial');
    expect(budgetCoverage([INVENTORY_CANCELLED_REASON]).status).toBe('partial');
    expect(budgetCoverage([INVENTORY_CANCELLED_REASON], false).status).toBe('unavailable');
  });
});

describe('emptyInventory last-resort snapshot', () => {
  it('publishes a schema-valid snapshot for an over-long reason set', () => {
    const inventory = emptyInventory(
      INPUT,
      new Set([...fillerReasons(200), INVENTORY_CANCELLED_REASON]),
    );

    expect(projectInventorySnapshotSchema.safeParse(inventory.snapshot).success).toBe(true);
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
    expect(inventory.snapshot.coverage.reasonCodes).toContain(REASON_CAP_REACHED);
  });

  it('survives a reason code the contract rejects rather than throwing on the failure path', () => {
    // `emptyInventory` IS the failure path. A producer that contributed an unpublishable
    // reason string must not be able to turn the degradation itself into a throw.
    const inventory = emptyInventory(INPUT, new Set(['not a valid reason code!!']));

    expect(projectInventorySnapshotSchema.safeParse(inventory.snapshot).success).toBe(true);
    expect(inventory.snapshot.coverage).toMatchObject({
      status: 'unavailable',
      reasonCodes: [INVENTORY_SNAPSHOT_INVALID_REASON],
      observed: 0,
    });
    expect(inventory.snapshot.project.configIdentity).toBe('config:unavailable');
  });

  it('carries the interruption forward even when the projection is withdrawn', () => {
    const inventory = emptyInventory(
      INPUT,
      new Set([INVENTORY_CANCELLED_REASON, 'not a valid reason code!!']),
    );

    expect(inventory.snapshot.coverage.reasonCodes).toEqual([
      INVENTORY_CANCELLED_REASON,
      INVENTORY_SNAPSHOT_INVALID_REASON,
    ]);
  });

  it('degrades an unusable config identity instead of publishing it', () => {
    const inventory = emptyInventory(
      { projectRoot: '/does-not-matter', configIdentity: 'x'.repeat(300) },
      new Set<string>(),
    );

    expect(inventory.snapshot.project.configIdentity).toBe('config:unavailable');
    expect(inventory.snapshot.coverage.reasonCodes).toContain('config-identity-invalid');
    expect(projectInventorySnapshotSchema.safeParse(inventory.snapshot).success).toBe(true);
  });
});
