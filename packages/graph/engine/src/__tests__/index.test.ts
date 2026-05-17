/**
 * Smoke test for the public barrel.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';

describe('@opensip-tools/graph index barrel', () => {
  it('re-exports graphTool', () => {
    expect(barrel.graphTool).toBeDefined();
    expect(barrel.graphTool.metadata.id).toBe('graph');
  });
});
