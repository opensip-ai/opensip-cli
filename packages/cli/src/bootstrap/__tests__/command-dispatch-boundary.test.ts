import { currentScope, RunScope } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { runCommandDispatchBoundary } from '../command-dispatch-boundary.js';
import { createCommandActionScopeRunner, disposeCurrentScope } from '../pre-action-hook.js';

describe('command dispatch boundary', () => {
  it('presents a rejected action inside its owned scope and disposes afterward', async () => {
    const runner = createCommandActionScopeRunner();
    const scope = new RunScope();
    const release = vi.fn();
    const disposeAmbientScope = vi.fn();
    scope.onDispose(release);
    runner.stage(scope);
    const actionError = new Error('action failed');
    const presentError = vi.fn(async (error: unknown) => {
      expect(error).toBe(actionError);
      expect(currentScope()).toBe(scope);
      expect(release).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(currentScope()).toBe(scope);
    });

    await runCommandDispatchBoundary({
      dispatch: () =>
        runner.run(() => {
          expect(currentScope()).toBe(scope);
          return Promise.reject(actionError);
        }),
      actionScope: runner,
      presentError,
      disposeAmbientScope,
    });

    expect(presentError).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(disposeAmbientScope).toHaveBeenCalledTimes(1);
    expect(currentScope()).toBeUndefined();
  });

  it('flushes audit + closes datastore on a raw Error and lets the next command enter scope', async () => {
    // Plan 09 Task 2.2: the run you most want audited is the one that failed
    // unexpectedly. A raw (non-ToolError) throw must still drain the
    // registered disposers (policy-audit flush, datastore close) and clear
    // the ambient ALS slot so an embedded host's NEXT command does not trip
    // the re-entrancy guard.
    const runner = createCommandActionScopeRunner();
    const flushPolicyAudit = vi.fn();
    const closeDatastore = vi.fn();
    const scope = new RunScope();
    scope.onDispose(flushPolicyAudit);
    scope.onDispose(closeDatastore);
    runner.stage(scope);

    await runCommandDispatchBoundary({
      dispatch: () =>
        runner.run(() => {
          throw new Error('raw unexpected failure');
        }),
      actionScope: runner,
      presentError: () => Promise.resolve(),
      disposeAmbientScope: disposeCurrentScope,
    });

    expect(flushPolicyAudit).toHaveBeenCalledTimes(1);
    expect(closeDatastore).toHaveBeenCalledTimes(1);
    expect(currentScope()).toBeUndefined();

    // Embedded-mode second command in the same process: staging + entering a
    // fresh scope succeeds without CORE.SCOPE.REENTRANT.
    const next = createCommandActionScopeRunner();
    const nextScope = new RunScope();
    next.stage(nextScope);
    await expect(next.run(() => Promise.resolve(currentScope()))).resolves.toBe(nextScope);
    next.disposeStaged();
    expect(currentScope()).toBeUndefined();
  });

  it('still disposes exactly once when error presentation rejects', async () => {
    const runner = createCommandActionScopeRunner();
    const scope = new RunScope();
    const release = vi.fn();
    const disposeAmbientScope = vi.fn();
    scope.onDispose(release);
    runner.stage(scope);
    const renderError = new Error('render failed');

    await expect(
      runCommandDispatchBoundary({
        dispatch: () =>
          runner.run(() => {
            throw new Error('action failed');
          }),
        actionScope: runner,
        presentError: () => {
          expect(currentScope()).toBe(scope);
          return Promise.reject(renderError);
        },
        disposeAmbientScope,
      }),
    ).rejects.toBe(renderError);

    expect(release).toHaveBeenCalledTimes(1);
    expect(disposeAmbientScope).toHaveBeenCalledTimes(1);
    expect(currentScope()).toBeUndefined();
  });
});
