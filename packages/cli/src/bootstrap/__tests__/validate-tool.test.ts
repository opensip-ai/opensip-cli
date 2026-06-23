import { defineCommand } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { isValidTool, toolValidationFailure } from '../validate-tool.js';

const minimalSpec = defineCommand({
  name: 'demo',
  description: 'demo command',
  commonFlags: ['json'],
  scope: 'none',
  output: 'command-result',
  handler: () => Promise.resolve({ type: 'text-lines', title: 't', lines: [] }),
});

describe('toolValidationFailure', () => {
  it('rejects deprecated top-level hooks with an actionable message', () => {
    const value = {
      identity: { name: 'demo' },
      metadata: { id: 'demo', name: 'demo', version: '0.0.0', description: 'demo' },
      commandSpecs: [minimalSpec],
      initialize: () => Promise.resolve(),
    };
    expect(isValidTool(value)).toBe(false);
    expect(toolValidationFailure(value)).toContain('extensionPoints');
    expect(toolValidationFailure(value)).toContain('initialize');
  });

  it('accepts hooks under extensionPoints', () => {
    const value = {
      identity: { name: 'demo' },
      metadata: { id: 'demo', name: 'demo', version: '0.0.0', description: 'demo' },
      commandSpecs: [minimalSpec],
      extensionPoints: {
        initialize: () => Promise.resolve(),
      },
    };
    expect(isValidTool(value)).toBe(true);
  });

  it('rejects tools without identity', () => {
    const value = {
      metadata: { id: 'demo', name: 'demo', version: '0.0.0', description: 'demo' },
      commandSpecs: [minimalSpec],
    };
    expect(isValidTool(value)).toBe(false);
    expect(toolValidationFailure(value)).toContain('Tool identity is required');
  });

  it('rejects metadata.name drift from identity.name', () => {
    const value = {
      identity: { name: 'demo' },
      metadata: { id: 'demo', name: 'other', version: '0.0.0', description: 'demo' },
      commandSpecs: [minimalSpec],
    };
    expect(isValidTool(value)).toBe(false);
    expect(toolValidationFailure(value)).toContain("must equal tool.identity.name 'demo'");
  });
});
