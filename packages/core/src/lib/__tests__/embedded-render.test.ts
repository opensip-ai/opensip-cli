import { describe, expect, it } from 'vitest';

import { isEmbeddedRender, runEmbeddedRender } from '../embedded-render.js';

describe('embedded-render mode', () => {
  it('is false outside runEmbeddedRender', () => {
    expect(isEmbeddedRender()).toBe(false);
  });

  it('is true inside runEmbeddedRender and resets after', () => {
    let inside = false;
    runEmbeddedRender(() => {
      inside = isEmbeddedRender();
    });
    expect(inside).toBe(true);
    expect(isEmbeddedRender()).toBe(false);
  });

  it('flows through async descendants of runEmbeddedRender', async () => {
    const seen = await runEmbeddedRender(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return isEmbeddedRender();
    });
    expect(seen).toBe(true);
    expect(isEmbeddedRender()).toBe(false);
  });

  it('returns the callback value', () => {
    expect(runEmbeddedRender(() => 42)).toBe(42);
  });
});
