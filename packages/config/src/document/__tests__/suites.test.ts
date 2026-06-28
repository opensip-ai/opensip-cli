import { describe, expect, it } from 'vitest';

import { suitesConfigSchema } from '../suites.js';

const TOOL_ID = '00000000-0000-4000-8000-000000000001';

describe('suitesConfigSchema', () => {
  it('accepts UUID-addressed tool steps with args', () => {
    expect(
      suitesConfigSchema.parse({
        security: {
          description: 'security suite',
          steps: [
            {
              tool: TOOL_ID,
              name: 'fitness',
              command: 'fit',
              args: { recipe: 'security', gateCompare: true },
            },
          ],
        },
      }),
    ).toEqual({
      security: {
        description: 'security suite',
        steps: [
          {
            tool: TOOL_ID,
            name: 'fitness',
            command: 'fit',
            args: { recipe: 'security', gateCompare: true },
          },
        ],
      },
    });
  });

  it('accepts reserved deferred v1 fields at the schema layer', () => {
    expect(
      suitesConfigSchema.parse({
        security: {
          execution: { mode: 'parallel', stopOnFirstFailure: true },
          steps: [{ tool: TOOL_ID, command: 'fit', cwd: 'src' }],
        },
      }),
    ).toEqual({
      security: {
        execution: { mode: 'parallel', stopOnFirstFailure: true },
        steps: [{ tool: TOOL_ID, command: 'fit', args: {}, cwd: 'src' }],
      },
    });
  });

  it('rejects invalid UUIDs, unknown step keys, and empty step lists', () => {
    expect(() =>
      suitesConfigSchema.parse({
        security: {
          steps: [{ tool: 'fitness', command: 'fit' }],
        },
      }),
    ).toThrow();
    expect(() =>
      suitesConfigSchema.parse({
        security: {
          steps: [{ tool: TOOL_ID, command: 'fit', extra: true }],
        },
      }),
    ).toThrow();
    expect(() =>
      suitesConfigSchema.parse({
        security: {
          steps: [],
        },
      }),
    ).toThrow();
  });
});
