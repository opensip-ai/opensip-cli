import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './render-markdown.js';

import type { EvalReport } from './model.js';

const REPORT: EvalReport = {
  cliVersion: '0.6.0',
  completedAt: '2026-07-12T20:01:00.000Z',
  contractFingerprint: `sha256:${'a'.repeat(64)}`,
  gitSha: 'abc1234',
  harnessVersion: '0.6.0',
  nodeVersion: 'v24.0.0',
  platform: 'darwin-arm64',
  promotionEligible: false,
  schemaVersion: 1,
  selectedArms: ['control', 'opensip'],
  sourceState: 'dirty',
  startedAt: '2026-07-12T20:00:00.000Z',
  tasks: [
    {
      arms: {
        control: {
          assertions: { incorrectNone: 0, passed: true, scopes: [] },
          metrics: {
            callCount: 2,
            incorrectNone: 0,
            responseBytes: 120,
            timeToFirstUsefulContextMs: 10.4,
            totalWallMs: 20,
          },
          record: {
            arm: 'control',
            legs: [],
            setup: { mode: 'fixture', stages: [] },
            strategyVersion: 'native-v1',
            taskId: 'entrypoint|trace',
          },
          recoveryMetrics: { callCount: 0, responseBytes: 0, totalWallMs: 0 },
        },
        opensip: {
          assertions: {
            incorrectNone: 1,
            passed: false,
            scopes: [],
            staleness: {
              postEditPassed: false,
              recoveryPassed: true,
              verdict: 'honestly-degraded',
            },
          },
          metrics: {
            callCount: 3,
            incorrectNone: 1,
            responseBytes: 90,
            timeToFirstUsefulContextMs: null,
            totalWallMs: 30,
          },
          record: {
            arm: 'opensip',
            legs: [],
            setup: {
              catalogProbe: {
                catalogIdentity: 'g1:fixture',
                durationMs: 7,
                responseBytes: 321,
              },
              mcp: {
                handshakeDurationMs: 5,
                mutationPosture: 'read-only',
                projectRootVerified: true,
                projectScope: 'project',
                stderr: { bytes: 10, truncated: false },
                surfaceEpoch: 4,
                surfaceVerified: true,
                toolCount: 21,
                toolNames: [],
                version: '0.6.0',
              },
              mode: 'fixture',
              stages: [{ durationMs: 15, exitCode: 0, name: 'graph' }],
            },
            strategyVersion: 'mcp-epoch-4-v1',
            taskId: 'entrypoint|trace',
          },
          recoveryMetrics: {
            callCount: 2,
            responseBytes: 40,
            totalWallMs: 12.6,
          },
        },
      },
      completedAt: '2026-07-12T20:00:30.000Z',
      taskId: 'entrypoint|trace',
    },
  ],
};

describe('renderMarkdown', () => {
  it('renders the stable human comparison table', () => {
    expect(renderMarkdown(REPORT)).toBe(`# OpenSIP agent evaluation

- Harness: 0.6.0
- OpenSIP CLI: 0.6.0
- Contract: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Git: abc1234
- Source: dirty (non-promotable)
- Platform: darwin-arm64
- Node: v24.0.0
- Started: 2026-07-12T20:00:00.000Z
- Completed: 2026-07-12T20:01:00.000Z

> Response bytes are the headline cross-arm unit. *Turns are deterministic tool calls, not literal model turns.

## entrypoint\\|trace

| Arm | Verdict | Incorrect none | Response bytes | Turns* | First useful | Setup time / catalog-probe bytes | Staleness | Recovery calls / bytes / time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| control | PASS | 0 | 120 B | 2 | 10 ms | 0 ms / 0 B | — | — |
| opensip | FAIL | 1 | 90 B | 3 | — | 27 ms / 321 B | honestly-degraded | 2 / 40 B / 13 ms |
`);
  });
});
