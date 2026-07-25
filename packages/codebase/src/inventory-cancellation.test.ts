import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  isToolErrorLike,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { INVENTORY_CANCELLED_REASON, INVENTORY_DEADLINE_REASON } from './inventory-helpers.js';
import { buildProjectInventory } from './inventory.js';

import type {
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  BoundedTargetResolver,
  TargetView,
} from '@opensip-cli/core';

/** A host targeting capability that answers only once the run's own signal aborts. */
class ParkUntilAbortedTargets implements BoundedTargetResolver {
  readonly globalExcludes: readonly string[] = [];
  parkedCalls = 0;

  getByName(): TargetView | undefined {
    return undefined;
  }

  getAll(): readonly TargetView[] {
    return [];
  }

  getByTag(): readonly TargetView[] {
    return [];
  }

  has(): boolean {
    return false;
  }

  resolveTargets(): readonly string[] {
    return [];
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    return files;
  }

  resolveTargetsBounded(
    _names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return this.park(options.signal);
  }

  applyGlobalExcludesBounded(
    _files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return this.park(options.signal);
  }

  private async park(signal: AbortSignal | undefined): Promise<BoundedTargetResolution> {
    this.parkedCalls += 1;
    if (signal !== undefined && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    return { files: [], capped: false, cancelled: true };
  }
}

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-cancellation-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  roots.push(root);
  return root;
}

function scope(abortSignal?: AbortSignal): RunScope {
  return new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildProjectInventory cancellation plane (D5)', () => {
  it('honours the ambient run cancel signal when the caller threads none', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    controller.abort();

    const inventory = await runWithScope(scope(controller.signal), () =>
      buildProjectInventory({ projectRoot: root, configIdentity: 'cfg' }),
    );

    expect(inventory.snapshot.coverage.status).toBe('unavailable');
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
    expect(inventory.snapshot.coverage.reasonCodes).not.toContain(INVENTORY_DEADLINE_REASON);
  });

  it('composes the caller signal with the ambient one instead of replacing it', async () => {
    const root = tempRoot();
    const ambient = new AbortController();
    const caller = new AbortController();
    caller.abort();

    const inventory = await runWithScope(scope(ambient.signal), () =>
      buildProjectInventory({ projectRoot: root, configIdentity: 'cfg', signal: caller.signal }),
    );

    expect(ambient.signal.aborted).toBe(false);
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
  });

  it('runs to completion when neither plane is aborted', async () => {
    const root = tempRoot();

    const inventory = await runWithScope(scope(), () =>
      buildProjectInventory({ projectRoot: root, configIdentity: 'cfg' }),
    );

    expect(inventory.snapshot.coverage.reasonCodes).not.toContain(INVENTORY_CANCELLED_REASON);
    expect(inventory.snapshot.coverage.reasonCodes).not.toContain(INVENTORY_DEADLINE_REASON);
  });

  it('reports an expired wall-clock deadline separately from an interrupt', async () => {
    const root = tempRoot();
    // The resolver parks until the composed signal aborts, so the build CANNOT finish
    // before its own deadline fires. Expiry is then an observed event, not an elapsed-time
    // guess (ADR-0169: event-based proofs, never "wait N ms and assume").
    const targets = new ParkUntilAbortedTargets();

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      targets,
      deadlineMs: 1,
    });

    expect(targets.parkedCalls).toBeGreaterThan(0);
    expect(inventory.snapshot.coverage.status).toBe('unavailable');
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_DEADLINE_REASON);
    expect(inventory.snapshot.coverage.reasonCodes).toContain(INVENTORY_CANCELLED_REASON);
  });
});

describe('buildProjectInventory input refusal', () => {
  it.each([
    ['files', { files: 0 }],
    ['packages', { packages: -1 }],
    ['manifestBytes', { manifestBytes: Number.NaN }],
    ['serializedBytes', { serializedBytes: Number.POSITIVE_INFINITY }],
  ])('refuses a %s bound that would silently widen the walk', async (field, limits) => {
    const root = tempRoot();

    await expect(
      buildProjectInventory({ projectRoot: root, configIdentity: 'cfg', limits }),
    ).rejects.toMatchObject({
      code: 'VALIDATION.CODEBASE.INVENTORY_INPUT_INVALID',
      metadata: { condition: 'not-positive-finite', field },
    });
  });

  it('carries the owning package on the refusal so attribution is not the host (D1)', async () => {
    const root = tempRoot();
    const error = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      limits: { files: 0 },
    }).catch((error_: unknown) => error_);

    expect(isToolErrorLike(error)).toBe(true);
    if (!isToolErrorLike(error)) return;
    expect(error.definition.owner.id).toBe('@opensip-cli/codebase');
    expect(error.definition.exitClass).toBe('runtime');
    expect(error.definition.defaultResponsibility).toBe('tool-author');
  });

  it('refuses a signal that is not an AbortSignal rather than ignoring cancellation', async () => {
    const root = tempRoot();
    const notASignal = { aborted: false } as AbortSignal;

    await expect(
      buildProjectInventory({ projectRoot: root, configIdentity: 'cfg', signal: notASignal }),
    ).rejects.toMatchObject({
      code: 'VALIDATION.CODEBASE.INVENTORY_INPUT_INVALID',
      metadata: { condition: 'not-an-abort-signal', field: 'signal' },
    });
  });

  it('accepts an omitted bound as the built-in maximum', async () => {
    const root = tempRoot();

    const inventory = await buildProjectInventory({
      projectRoot: root,
      configIdentity: 'cfg',
      limits: {},
    });

    // Absence is an override that was never made, not a malformed one: no refusal, and the
    // only qualification is the missing targeting capability this fixture does not supply.
    expect(inventory.snapshot.coverage.reasonCodes).toEqual(['targets-unavailable']);
  });
});
