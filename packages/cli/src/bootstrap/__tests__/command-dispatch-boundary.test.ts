import { currentScope, RunScope } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { runCommandDispatchBoundary } from '../command-dispatch-boundary.js';
import { createCommandActionScopeRunner } from '../pre-action-hook.js';

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
