import { describe, it, expect, expectTypeOf } from 'vitest';

import { ToolError } from '../../lib/errors.js';
import { UnknownLiveViewError } from '../types.js';

import type { LiveViewRenderer } from '../types.js';

describe('UnknownLiveViewError', () => {
  it('is constructible with a viewKey and produces an actionable message', () => {
    const err = new UnknownLiveViewError('fit');
    expect(err).toBeInstanceOf(UnknownLiveViewError);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(Error);
    expect(err.viewKey).toBe('fit');
    expect(err.code).toBe('UNKNOWN_LIVE_VIEW');
    expect(err.name).toBe('UnknownLiveViewError');
    expect(err.message).toContain("'fit'");
    expect(err.message).toContain('registerLiveView');
  });

  it('preserves a custom error code when provided via options', () => {
    const err = new UnknownLiveViewError('graph', { code: 'CUSTOM_CODE' });
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.viewKey).toBe('graph');
  });

  it('chains a cause through ToolErrorOptions', () => {
    const cause = new Error('root');
    const err = new UnknownLiveViewError('graph', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('LiveViewRenderer', () => {
  it('is exported as a structural type that accepts an unknown args payload', () => {
    expectTypeOf<LiveViewRenderer>().toBeFunction();
    expectTypeOf<LiveViewRenderer>()
      .parameter(0)
      .toBeUnknown();
    expectTypeOf<LiveViewRenderer>()
      .returns.resolves.toBeVoid();
  });

  it('accepts a function value at runtime', () => {
    const renderer: LiveViewRenderer = async () => undefined;
    expect(typeof renderer).toBe('function');
  });
});
