import { defineCommand, definePrimaryCommand, ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { bundledReplayResolver } from '../bundled-replay.js';

import type { StoredSession } from '@opensip-cli/contracts';

const session: StoredSession = {
  id: 'FIT_01',
  tool: 'fit',
  startedAt: '2026-05-21T12:00:00.000Z',
  completedAt: '2026-05-21T12:00:00.000Z',
  cwd: '/proj',
  score: 100,
  passed: true,
  durationMs: 100,
};

const replaySession = () => ({
  fidelity: 'projection' as const,
  envelope: {
    schemaVersion: 2 as const,
    tool: 'fit',
    runId: 'r1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
  },
});

describe('bundledReplayResolver', () => {
  it('returns undefined for tools without a sessionReplay contribution', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'plain', layoutKey: 'plain' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000401',
        name: 'plain',
        version: '0.0.0',
        description: 'plain',
      },
      commands: [{ name: 'plain', description: 'plain' }],
      commandSpecs: [
        definePrimaryCommand({
          description: 'plain',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          handler: () => Promise.resolve({ type: 'text-lines', lines: [] }),
        }),
      ],
    });

    expect(bundledReplayResolver(tools)('plain')).toBeUndefined();
  });

  it('maps layout keys to replay closures that delegate to the tool contribution', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'fitness', layoutKey: 'fit' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000402',
        name: 'fitness',
        version: '0.0.0',
        description: 'fitness',
      },
      commands: [{ name: 'fit', description: 'fit' }],
      commandSpecs: [
        defineCommand({
          name: 'fit',
          description: 'fit',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          handler: () => Promise.resolve({ type: 'text-lines', lines: [] }),
        }),
      ],
      extensionPoints: {
        sessionReplay: { tool: 'fit', replaySession },
      },
    });

    const resolve = bundledReplayResolver(tools);
    expect(resolve('fit')?.(session)).toEqual(replaySession());
  });
});
