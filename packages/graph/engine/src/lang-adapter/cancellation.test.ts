import {
  createDeadlineError,
  LanguageRegistry,
  RunScope,
  runWithScopeSync,
  ToolRegistry,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { throwIfGraphAdapterAborted } from './cancellation.js';

describe('graph adapter cancellation', () => {
  it('uses the registered cancellation definition for a normal abort', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfGraphAdapterAborted(controller.signal, 'test')).toThrow(
      expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }),
    );
  });

  it('maps native timeout aborts to the registered deadline definition', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('expired', 'TimeoutError'));

    expect(() => throwIfGraphAdapterAborted(controller.signal, 'test')).toThrow(
      expect.objectContaining({ code: 'CORE.SYSTEM.DEADLINE_EXCEEDED' }),
    );
  });

  it('preserves an already-defined host reason and defaults to the scope signal', () => {
    const deadline = createDeadlineError('host deadline');
    const controller = new AbortController();
    controller.abort(deadline);
    const scope = new RunScope({
      abortSignal: controller.signal,
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
    });

    try {
      expect(() =>
        runWithScopeSync(scope, () => throwIfGraphAdapterAborted(undefined, 'test')),
      ).toThrow(deadline);
    } finally {
      scope.dispose();
    }
  });
});
